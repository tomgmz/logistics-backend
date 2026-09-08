/**
 * Seeds completed bookings a client can immediately file reverse billing for,
 * then reports the resulting billing state.
 *
 *   npx tsx scripts/seed-billable-bookings.ts <email>
 *   npx tsx scripts/seed-billable-bookings.ts <email> --clean
 *
 * The dates are not fixed. It asks billing-calendar which cut-off has actually
 * closed AND has its submission window open today, then places the bookings
 * inside that period — hardcoded dates would silently stop being fileable as
 * soon as the month turned.
 *
 * This writes real rows. `--clean` removes exactly what it created, found by
 * the marker it puts in the origin field.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import { phDay } from '../src/lib/ph-date.js'
import { buildMonthlyCutoffs, buildWeeklyPeriods, weekday } from '../src/lib/billing-calendar.js'
import {
  advancePeriodStates,
  ensurePeriodsForClient,
} from '../src/services/billing/billing-periods.service.js'

/** Lets --clean find these again without touching anything real. */
const MARKER = '[seed]'

const email = process.argv[2]
const clean = process.argv.includes('--clean')
if (!email) {
  console.error('usage: npx tsx scripts/seed-billable-bookings.ts <client email> [--clean]')
  process.exit(1)
}

const today = phDay()

const { rows: found } = await pool.query(
  `select c.client_id, c.company_name, c.billing_mode,
          trim(concat_ws(' ', u.first_name, u.last_name)) as name
     from clients c join users u on u.user_id = c.user_id
    where lower(u.email) = lower($1)`,
  [email],
)
if (!found.length) {
  console.error(`No client found for ${email}`)
  process.exit(1)
}
const client = found[0]
console.log(`\n${client.name} — ${client.company_name} (${client.billing_mode})`)
console.log(`today: ${today}\n`)

if (clean) {
  const { rowCount } = await pool.query(
    `delete from bookings where client_id = $1 and origin like $2`,
    [client.client_id, `${MARKER}%`],
  )
  console.log(`removed ${rowCount} seeded booking(s)`)
  await pool.end()
  process.exit(0)
}

/**
 * The period the client can act on right now: one that has closed and whose
 * window is open. Looks back a few cycles, because the current period is
 * normally still running.
 */
function findFileablePeriod() {
  const [y, m] = today.split('-').map(Number)
  for (let back = 0; back <= 3; back++) {
    let yy = y
    let mm = m - back
    while (mm < 1) { mm += 12; yy -= 1 }

    if (client.billing_mode === 'monthly') {
      for (const c of buildMonthlyCutoffs(yy, mm)) {
        if (c.periodEnd < today && c.submissionWindow.start <= today) {
          return {
            start: c.periodStart, end: c.periodEnd,
            label: `cut-off ${c.cutoffNo}`, window: c.submissionWindow,
          }
        }
      }
    } else {
      // Weekly waits on 8338 to send the summary, so the best this can do is put
      // work in a week that has closed and is ready to be consolidated.
      for (const w of buildWeeklyPeriods(yy, mm).reverse()) {
        if (w.periodEnd < today) {
          return { start: w.periodStart, end: w.periodEnd, label: 'weekly', window: w.reviewWindow }
        }
      }
    }
  }
  return null
}

const period = findFileablePeriod()
if (!period) {
  console.error('No closed period with an open window — nothing would be fileable.')
  process.exit(1)
}
console.log(`target period: ${period.start}..${period.end} (${period.label})`)
console.log(`client window: ${period.window.start}..${period.window.end}\n`)

/** Operating days spread across the period. 8338 does not run Sundays. */
function pickDates(start: string, end: string, want = 3): string[] {
  const out: string[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  while (cursor <= last) {
    const d = cursor.toISOString().slice(0, 10)
    if (weekday(d) !== 0) out.push(d)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  if (out.length <= want) return out
  const step = Math.floor(out.length / want)
  return Array.from({ length: want }, (_, i) => out[i * step])
}

const dates = pickDates(period.start, period.end)

const ROUTES = [
  {
    origin: 'Paranaque City Distribution Hub, Dr. A. Santos Ave, Paranaque',
    dests: ['Makati CBD Warehouse, Chino Roces Ave, Makati', 'BGC Logistics Center, 5th Ave, Taguig'],
    truck: 'Hino Wing Van',
    terms: '30',
  },
  {
    origin: 'Cabuyao Warehouse, Mamatid, City of Cabuyao, Laguna',
    dests: ['Quezon City Depot, Mindanao Ave, Quezon City'],
    truck: 'Isuzu NQR Closed Van',
    terms: '45',
  },
  {
    origin: 'Muntinlupa Cold Storage, Alabang, Muntinlupa',
    dests: ['Pasay Cold Storage Facility, EDSA Extension, Pasay', 'Las Pinas Warehouse, Alabang-Zapote Rd'],
    truck: 'Hino Wing Van',
    terms: '60',
  },
]

const CALL_TIMES = ['08:00', '06:30', '13:00']
const WEIGHTS = [450, 720, 390]
const VOLUMES = [2.4, 3.6, 2.1]

const created: { ref: string; date: string; terms: string }[] = []
const db = await pool.connect()
try {
  await db.query('BEGIN')
  for (const [i, date] of dates.entries()) {
    const route = ROUTES[i % ROUTES.length]
    const { rows } = await db.query(
      `insert into bookings
         (client_id, origin, truck_type_needed, schedule_date, call_time,
          status, payment_terms, required_weight_kg, required_volume_cbm)
       values ($1, $2, $3, $4::date, $5::time, 'completed', $6, $7, $8)
       returning booking_id, reference_number`,
      [
        client.client_id,
        `${MARKER} ${route.origin}`,
        route.truck,
        date,
        CALL_TIMES[i % 3],
        route.terms,
        WEIGHTS[i % 3],
        VOLUMES[i % 3],
      ],
    )
    const booking = rows[0]
    for (const [j, address] of route.dests.entries()) {
      await db.query(
        `insert into booking_destinations (booking_id, address, sequence_order, status, delivered_at)
         values ($1, $2, $3, 'delivered', $4::date + time '16:00')`,
        [booking.booking_id, address, j + 1, date],
      )
    }
    created.push({ ref: booking.reference_number, date, terms: route.terms })
  }
  await db.query('COMMIT')
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  throw err
} finally {
  db.release()
}

console.log('created:')
for (const b of created) console.log(`  ${b.ref}  ${b.date}  ${b.terms}-day terms`)

// The same calls the client's own screen makes when it opens.
await ensurePeriodsForClient(client.client_id, client.billing_mode)
await advancePeriodStates(client.client_id)

const { rows: periods } = await pool.query(
  `select to_char(period_start,'YYYY-MM-DD') s, to_char(period_end,'YYYY-MM-DD') e,
          cutoff_no, status,
          to_char(submission_start,'YYYY-MM-DD') w1, to_char(submission_end,'YYYY-MM-DD') w2,
          (select count(*) from bookings b
            where b.client_id = p.client_id and b.status = 'completed'
              and b.schedule_date between p.period_start and p.period_end) as deliveries
     from billing_periods p where client_id = $1 order by period_start`,
  [client.client_id],
)

console.log('\nbilling periods now:')
for (const p of periods) {
  const actionable =
    ['awaiting_submission', 'awaiting_client_approval'].includes(p.status) && Number(p.deliveries) > 0
  console.log(
    `  ${p.s}..${p.e}${p.cutoff_no ? ` c${p.cutoff_no}` : '   '}  ${String(p.status).padEnd(22)}` +
    `window ${p.w1}..${p.w2}  ${p.deliveries} delivery(ies)${actionable ? '   <== CAN FILE NOW' : ''}`,
  )
}

await pool.end()
