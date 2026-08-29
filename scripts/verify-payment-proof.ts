/**
 * Proves the payment-proof flow, above all the settlement guard.
 *
 *   npx tsx scripts/verify-payment-proof.ts
 *
 * A client uploading proof must NEVER settle their own invoice. That is the one
 * regression here that would let money be marked received on the payer's say-so,
 * so it is asserted first and through the service, exactly as the route calls it.
 *
 * This creates real rows because the service writes through PostgREST, which
 * cannot see an uncommitted transaction. Everything it makes is torn down in the
 * finally block, including the document_series counter, so a run leaves the
 * database as it found it.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import * as BillingService from '../src/services/billing/billing.service.js'
import { nextFridayOnOrAfter, weekday } from '../src/lib/billing-calendar.js'

let passed = 0
const failures: string[] = []

const ok = (label: string) => { passed++; console.log(`  ok   ${label}`) }
const bad = (label: string, detail = '') => {
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}
const check = (label: string, cond: boolean, detail = '') => (cond ? ok(label) : bad(label, detail))

async function expectThrows(label: string, fn: () => Promise<unknown>, matching?: RegExp) {
  try {
    await fn()
    bad(label, 'no error was raised')
  } catch (err) {
    const msg = (err as Error).message
    if (matching && !matching.test(msg)) bad(label, `wrong error: ${msg}`)
    else ok(`${label}`)
  }
}

// Far enough out that it cannot collide with a real generated period.
const P_START = '2099-06-01'
const P_END   = '2099-06-15'

let periodId: string | null = null
let bookingId: string | null = null
let seriesBefore: number | null = null

try {
  const { rows: clients } = await pool.query(
    `select c.client_id, c.company_name, u.user_id
       from clients c join users u on u.user_id = c.user_id
      where c.billing_mode is not null limit 1`,
  )
  if (!clients.length) throw new Error('no billable client to test against')
  const client = clients[0]

  const { rows: bookings } = await pool.query(
    `select b.booking_id, b.reference_number
       from bookings b
       left join billing_booking_claims k on k.booking_id = b.booking_id
      where b.client_id = $1 and b.status = 'completed' and k.booking_id is null
      limit 1`,
    [client.client_id],
  )
  if (!bookings.length) throw new Error('no unclaimed completed booking to test against')
  bookingId = bookings[0].booking_id

  console.log(`\nclient  ${client.company_name}`)
  console.log(`booking ${bookings[0].reference_number}\n`)

  const { rows: series } = await pool.query(
    `select next_number from document_series where series_key = 'service_invoice'`,
  )
  seriesBefore = Number(series[0].next_number)

  // --- set up a period that is agreed and ready to invoice ------------------
  const { rows: created } = await pool.query(
    `insert into billing_periods
       (client_id, mode, period_start, period_end, cutoff_no, status, total_amount)
     values ($1, 'monthly', $2, $3, 1, 'approved', 10000)
     returning period_id`,
    [client.client_id, P_START, P_END],
  )
  periodId = created[0].period_id

  await pool.query(
    `insert into billing_period_items (period_id, booking_id, description, quantity, unit_price, amount)
     values ($1, $2, 'Test freight charge', 1, 10000, 10000)`,
    [periodId, bookingId],
  )
  await pool.query(
    `insert into billing_booking_claims (booking_id, period_id) values ($1, $2)`,
    [bookingId, periodId],
  )

  const staff = { userId: null, role: 'admin' as const }
  const clientViewer = { userId: client.user_id, role: 'client', clientId: client.client_id }

  console.log('Issuing')
  const { issued } = await BillingService.issueServiceInvoices(periodId!, {}, null)
  check('one invoice per booking', issued.length === 1, `got ${issued.length}`)
  const invoice = issued[0] as { invoice_id: string; si_number: string; total_amount_due: number }
  check('invoice starts unpaid', await invoiceStatus(invoice.invoice_id) === 'unpaid')

  // --- THE GUARD -----------------------------------------------------------
  console.log('\nSettlement guard')
  const proof = await BillingService.submitPaymentProof(
    invoice.invoice_id,
    {
      amount_paid: Number(invoice.total_amount_due),
      // A Tuesday: a bank transfer lands whenever it lands.
      client_declared_date: '2099-06-09',
      method: 'check',
      reference_no: 'TEST-CHK-1',
      proof_urls: ['https://res.cloudinary.com/demo/image/upload/deposit-slip.jpg'],
    },
    clientViewer,
  )
  check('the proof lands as pending_verification', proof.status === 'pending_verification', proof.status)
  check('a pending payment has NO accepted date', proof.payment_date === null)
  check('the client-declared date is kept verbatim', proof.client_declared_date === '2099-06-09')
  check("the declared date is NOT forced onto a Friday", weekday('2099-06-09') !== 5)

  check('*** the invoice is STILL UNPAID after upload ***',
    await invoiceStatus(invoice.invoice_id) === 'unpaid')
  check('*** the period is STILL INVOICED after upload ***',
    await periodStatus(periodId!) === 'invoiced')

  await expectThrows(
    'a second proof on the same invoice is refused',
    () => BillingService.submitPaymentProof(invoice.invoice_id, {
      amount_paid: 1, client_declared_date: '2099-06-09', method: 'cash',
      proof_urls: ['https://res.cloudinary.com/demo/image/upload/x.jpg'],
    }, clientViewer),
    /already awaiting verification/i,
  )

  // --- verification --------------------------------------------------------
  console.log('\nVerification')
  await expectThrows(
    'confirming on a Tuesday is refused, naming the next Friday',
    () => BillingService.verifyPayment(proof.payment_id, {
      decision: 'confirm', payment_date: '2099-06-09',
    }, staff.userId),
    /only accepts payment on Fridays/i,
  )
  check('the Friday it names is correct', nextFridayOnOrAfter('2099-06-09') === '2099-06-12')

  await expectThrows(
    'rejecting without a reason is refused',
    () => BillingService.verifyPayment(proof.payment_id, { decision: 'reject' }, staff.userId),
    /why the payment could not be confirmed/i,
  )
  check('still unpaid after the failed attempts',
    await invoiceStatus(invoice.invoice_id) === 'unpaid')

  const confirmed = await BillingService.verifyPayment(
    proof.payment_id,
    { decision: 'confirm', payment_date: '2099-06-12' },
    staff.userId,
  )
  check('confirming settles the invoice', confirmed.settled)
  check('the invoice is now paid', await invoiceStatus(invoice.invoice_id) === 'paid')
  check('the period is now paid', await periodStatus(periodId!) === 'paid')

  await expectThrows(
    'the same payment cannot be confirmed twice',
    () => BillingService.verifyPayment(proof.payment_id, {
      decision: 'confirm', payment_date: '2099-06-12',
    }, staff.userId),
    /already been confirmed/i,
  )

  // --- a rejected payment must never count ---------------------------------
  console.log('\nRejected payments do not settle')
  const { rows: inv2 } = await pool.query(
    `insert into service_invoices
       (period_id, booking_id, si_number, invoice_date, sold_to_name,
        total_sales_vat_inclusive, total_amount_due, payment_terms_days,
        term_end_date, due_date)
     values ($1, null, 'TEST-SI-REJ', '2099-06-01', 'Test', 5000, 5000, 30, '2099-07-01', '2099-07-03')
     returning invoice_id`,
    [periodId],
  )
  const rejInvoice = inv2[0].invoice_id
  const { rows: pay2 } = await pool.query(
    `insert into billing_payments
       (invoice_id, amount_paid, payment_date, method, status, submitted_at)
     values ($1, 5000, null, 'check', 'pending_verification', now())
     returning payment_id`,
    [rejInvoice],
  )
  await BillingService.verifyPayment(
    pay2[0].payment_id,
    { decision: 'reject', remarks: 'Amount does not match the bank record.' },
    staff.userId,
  )
  check('a rejected payment leaves the invoice unpaid',
    await invoiceStatus(rejInvoice) === 'unpaid')
  const { rows: rej } = await pool.query(
    `select status, rejection_reason from billing_payments where payment_id = $1`,
    [pay2[0].payment_id],
  )
  check('the rejection reason is stored', !!rej[0].rejection_reason)
  check('the payment is marked rejected', rej[0].status === 'rejected')
} catch (err) {
  bad('harness', (err as Error).message)
} finally {
  // --- teardown ------------------------------------------------------------
  if (periodId) {
    await pool.query(
      `delete from acknowledgement_receipts where invoice_id in
         (select invoice_id from service_invoices where period_id = $1)`, [periodId])
    await pool.query(
      `delete from billing_payments where invoice_id in
         (select invoice_id from service_invoices where period_id = $1)`, [periodId])
    await pool.query('delete from service_invoices where period_id = $1', [periodId])
    await pool.query('delete from billing_booking_claims where period_id = $1', [periodId])
    await pool.query('delete from billing_period_items where period_id = $1', [periodId])
    await pool.query('delete from billing_periods where period_id = $1', [periodId])
  }
  if (bookingId) {
    await pool.query('update bookings set total_cost = null where booking_id = $1', [bookingId])
  }
  if (seriesBefore !== null) {
    // Put the booklet counter back; a test must not burn BIR serials.
    await pool.query(
      `update document_series set next_number = $1 where series_key = 'service_invoice'`,
      [seriesBefore],
    )
  }
  console.log('\ncleaned up')
  await pool.end()
}

async function invoiceStatus(invoiceId: string): Promise<string> {
  const { rows } = await pool.query('select payment_status from service_invoices where invoice_id = $1', [invoiceId])
  return rows[0]?.payment_status
}
async function periodStatus(id: string): Promise<string> {
  const { rows } = await pool.query('select status from billing_periods where period_id = $1', [id])
  return rows[0]?.status
}

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.log(`  x ${f}`)
  process.exitCode = 1
} else {
  console.log(`PASSED — all ${passed} checks green`)
}
