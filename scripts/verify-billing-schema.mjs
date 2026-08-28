/**
 * Proves the reverse-billing constraints behave on the REAL schema.
 *
 *   node scripts/verify-billing-schema.mjs
 *
 * Everything runs inside one transaction that is always rolled back, so it can
 * be pointed at the live database without leaving a row behind. The point is to
 * check the guarantees that the application depends on but cannot enforce
 * itself:
 *
 *   - a booking can be claimed by only ONE billing period
 *   - a booking can be invoiced only ONCE
 *   - a period may hold MANY invoices (one per booking)
 *   - several charge lines may share a booking (the per-item breakdown)
 */
import 'dotenv/config'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const db = await pool.connect()

let passed = 0
const failures = []

function ok(label) { passed++; console.log(`  ok   ${label}`) }
function bad(label, detail) { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }

/** Runs `fn` in a savepoint; reports whether it violated a constraint. */
async function expectReject(label, sql, params) {
  await db.query('savepoint sp')
  try {
    await db.query(sql, params)
    await db.query('rollback to savepoint sp')
    bad(label, 'the database ALLOWED it')
  } catch (err) {
    await db.query('rollback to savepoint sp')
    // 23505 unique, 23503 foreign key, 23514 check — all are the database
    // correctly refusing the row. Anything else is a real problem.
    const REFUSALS = { 23505: 'unique', 23503: 'foreign key', 23514: 'check' }
    if (REFUSALS[err.code]) ok(`${label} (${REFUSALS[err.code]} constraint)`)
    else bad(label, `unexpected error ${err.code}: ${err.message}`)
  }
}

async function expectAllow(label, sql, params) {
  await db.query('savepoint sp')
  try {
    await db.query(sql, params)
    await db.query('release savepoint sp')
    ok(label)
  } catch (err) {
    await db.query('rollback to savepoint sp')
    bad(label, `${err.code}: ${err.message}`)
  }
}

try {
  await db.query('BEGIN')

  const { rows: clients } = await db.query('select client_id from clients limit 1')
  if (!clients.length) throw new Error('no clients in the database to test against')
  const clientId = clients[0].client_id

  const { rows: bookings } = await db.query(
    'select booking_id from bookings where client_id = $1 limit 2',
    [clientId],
  )
  // Fall back to any bookings if this client has none; the FKs are what matter.
  const { rows: anyBookings } = bookings.length >= 2
    ? { rows: bookings }
    : await db.query('select booking_id from bookings limit 2')
  if (anyBookings.length < 2) throw new Error('need at least 2 bookings in the database')
  const [b1, b2] = anyBookings.map((b) => b.booking_id)

  console.log(`\nusing client ${clientId}`)
  console.log(`bookings ${b1}, ${b2}\n`)

  const mkPeriod = async (start, end) => {
    const { rows } = await db.query(
      `insert into billing_periods (client_id, mode, period_start, period_end, cutoff_no, status)
       values ($1, 'monthly', $2, $3, 1, 'consolidating') returning period_id`,
      [clientId, start, end],
    )
    return rows[0].period_id
  }

  console.log('Billing periods')
  const p1 = await mkPeriod('2099-01-01', '2099-01-15')
  ok('a period can be created')
  const p2 = await mkPeriod('2099-02-01', '2099-02-15')
  ok('a second, different period can be created')

  await expectReject(
    'the same client+mode+range cannot be created twice',
    `insert into billing_periods (client_id, mode, period_start, period_end, cutoff_no, status)
     values ($1, 'monthly', '2099-01-01', '2099-01-15', 1, 'draft')`,
    [clientId],
  )

  await expectReject(
    'a weekly period cannot carry a cutoff number',
    `insert into billing_periods (client_id, mode, period_start, period_end, cutoff_no, status)
     values ($1, 'weekly', '2099-03-02', '2099-03-07', 1, 'draft')`,
    [clientId],
  )

  console.log('\nCharge lines')
  await expectAllow(
    'a booking can carry several charge lines (per-item breakdown)',
    `insert into billing_period_items (period_id, booking_id, description, quantity, unit_price, amount)
     values ($1, $2, 'Freight charge', 1, 18500, 18500),
            ($1, $2, 'Fuel surcharge', 1, 1500, 1500)`,
    [p1, b1],
  )

  console.log('\nBooking claims')
  await expectAllow(
    'a period can claim a booking',
    'insert into billing_booking_claims (booking_id, period_id) values ($1, $2)',
    [b1, p1],
  )
  await expectReject_sameBooking()

  async function expectReject_sameBooking() {
    await expectReject(
      'a SECOND period cannot claim the same booking',
      'insert into billing_booking_claims (booking_id, period_id) values ($1, $2)',
      [b1, p2],
    )
  }

  await expectAllow(
    'a different booking can be claimed by the same period',
    'insert into billing_booking_claims (booking_id, period_id) values ($1, $2)',
    [b2, p1],
  )

  console.log('\nService Invoices — one per booking, many per period')
  const mkInvoice = `insert into service_invoices
      (period_id, booking_id, si_number, invoice_date, sold_to_name,
       total_sales_vat_inclusive, total_amount_due,
       payment_terms_days, term_end_date, due_date)
    values ($1, $2, $3, '2099-01-20', 'Test Client', 20000, 20000, $4, '2099-02-19', '2099-02-19')`

  await expectAllow(
    'an invoice can be issued for a booking',
    mkInvoice, [p1, b1, 'TEST-SI-1', 30],
  )
  await expectAllow(
    'a SECOND invoice on the SAME period, different booking (per-booking billing)',
    mkInvoice, [p1, b2, 'TEST-SI-2', 60],
  )
  await expectReject(
    'a booking cannot be invoiced twice',
    mkInvoice, [p2, b1, 'TEST-SI-3', 30],
  )
  await expectReject(
    'two invoices cannot share a serial number',
    mkInvoice, [p2, null, 'TEST-SI-1', 30],
  )

  const { rows: counted } = await db.query(
    'select count(*)::int n from service_invoices where period_id = $1', [p1],
  )
  if (counted[0].n === 2) ok('the period really does hold 2 invoices')
  else bad('the period should hold 2 invoices', `found ${counted[0].n}`)

  await expectReject(
    'an unsupported payment term is refused',
    mkInvoice, [p2, null, 'TEST-SI-4', 90],
  )

  console.log('\nrolling back — nothing was kept')
  await db.query('ROLLBACK')
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('\nharness error:', err.message)
  process.exitCode = 1
} finally {
  db.release()
  await pool.end()
}

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.log(`  x ${f}`)
  process.exitCode = 1
} else {
  console.log(`PASSED — all ${passed} schema guarantees hold`)
}
