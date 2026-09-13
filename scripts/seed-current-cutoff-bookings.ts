/**
 * Seeds completed bookings into each client's CURRENT, still-open billing
 * period — the cut-off the calendar says we are living in today.
 *
 *   npx tsx scripts/seed-current-cutoff-bookings.ts
 *   npx tsx scripts/seed-current-cutoff-bookings.ts --dry-run
 *
 * This is deliberately the opposite of seed-billable-bookings.ts, which hunts
 * for a period that has already CLOSED so the client can file immediately. Here
 * the work lands in the live period, so the reverse billing cannot be driven
 * past consolidation until that period's own dates arrive. That is the point:
 * it exercises the real waiting behaviour rather than skipping to the end.
 *
 * Clients are seeded by email and each gets whichever arrangement their own
 * record says — 'monthly' lands in a 1st-15th / 16th-EOM cut-off, 'weekly' in a
 * Mon-Sat billing week.
 *
 * Marked `[seed]` in the origin field, so scripts/teardown-seed-bookings.mjs
 * removes these along with anything reverse billing later builds on them.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import { phDay } from '../src/lib/ph-date.js'
import { periodBoundsFor, weekday, type Day } from '../src/lib/billing-calendar.js'
import {
  advancePeriodStates,
  ensurePeriodsForClient,
} from '../src/services/billing/billing-periods.service.js'
import type { BillingMode } from '../src/types/billing.types.js'

/** Lets the teardown script find these again without touching anything real. */
const MARKER = '[seed]'

const EMAILS = ['tomervingmz@gmail.com', 'cla.gallerydiary@gmail.com']

const dryRun = process.argv.includes('--dry-run')
const today = phDay()

/**
 * Routes worth billing differently. The payment term varies per route because a
 * Service Invoice covers exactly one booking and carries that booking's own
 * term — so a period seeded with mixed terms produces invoices that fall due on
 * different Fridays, which is the case most likely to be got wrong.
 */
const ROUTES = [
  {
    origin: 'Paranaque City Distribution Hub, Dr. A. Santos Ave, Paranaque',
    dests: [
      'Makati CBD Warehouse, Chino Roces Ave, Makati',
      'BGC Logistics Center, 5th Ave, Taguig',
    ],
    truck: 'Hino Wing Van',
    terms: '30',
    callTime: '08:00',
    weightKg: 450,
    volumeCbm: 2.4,
    cost: 18500,
  },
  {
    origin: 'Cabuyao Warehouse, Mamatid, City of Cabuyao, Laguna',
    dests: ['Quezon City Depot, Mindanao Ave, Quezon City'],
    truck: 'Isuzu NQR Closed Van',
    terms: '45',
    callTime: '06:30',
    weightKg: 720,
    volumeCbm: 3.6,
    cost: 24750,
  },
  {
    origin: 'Muntinlupa Cold Storage, Alabang, Muntinlupa',
    dests: [
      'Pasay Cold Storage Facility, EDSA Extension, Pasay',
      'Las Pinas Warehouse, Alabang-Zapote Rd',
    ],
    truck: 'Hino Wing Van',
    terms: '60',
    callTime: '13:00',
    weightKg: 390,
    volumeCbm: 2.1,
    cost: 15200,
  },
  {
    origin: 'Valenzuela Dry Goods Hub, Karuhatan, Valenzuela',
    dests: ['Caloocan Trading Post, Samson Rd, Caloocan'],
    truck: 'Isuzu NQR Closed Van',
    terms: '30',
    callTime: '07:15',
    weightKg: 610,
    volumeCbm: 3.0,
    cost: 21300,
  },
]

/**
 * Operating days already behind us inside the period.
 *
 * Capped at `today` because a completed booking dated in the future is not a
 * thing that can have happened, and 8338 does not run Sundays.
 */
function pickDates(start: Day, end: Day, want: number): Day[] {
  const last = end < today ? end : today
  const out: Day[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const stop = new Date(`${last}T00:00:00Z`)
  while (cursor <= stop) {
    const d = cursor.toISOString().slice(0, 10)
    if (weekday(d) !== 0) out.push(d)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  if (out.length <= want) return out
  // Spread across the period rather than bunching at the start, so the
  // deliveries list looks like a fortnight of work instead of one busy Monday.
  const step = (out.length - 1) / (want - 1)
  return Array.from({ length: want }, (_, i) => out[Math.round(i * step)])
}

const db = await pool.connect()

try {
  await db.query('BEGIN')

  for (const email of EMAILS) {
    const { rows: found } = await db.query(
      `select c.client_id, c.company_name, c.billing_mode,
              trim(concat_ws(' ', u.first_name, u.last_name)) as name
         from clients c join users u on u.user_id = c.user_id
        where lower(u.email) = lower($1)`,
      [email],
    )
    if (!found.length) throw new Error(`No client found for ${email}`)
    const client = found[0]
    const mode = client.billing_mode as BillingMode

    const period = periodBoundsFor(today, mode)
    const label = period.mode === 'monthly' ? `cut-off ${period.cutoffNo}` : 'billing week'

    console.log(`\n${client.name} — ${client.company_name} (${mode})`)
    console.log(`  current ${label}: ${period.periodStart}..${period.periodEnd}`)

    const dates = pickDates(period.periodStart, period.periodEnd, 4)
    if (!dates.length) {
      throw new Error(
        `The current ${label} for ${email} has no elapsed operating day yet — ` +
        'nothing could honestly be marked completed.',
      )
    }

    for (const [i, date] of dates.entries()) {
      const route = ROUTES[i % ROUTES.length]
      const { rows } = await db.query(
        `insert into bookings
           (client_id, origin, truck_type_needed, schedule_date, call_time,
            status, payment_terms, required_weight_kg, required_volume_cbm,
            total_cost, gm_status, ops_status, fleet_status, accounting_status,
            cargo_details)
         values ($1, $2, $3, $4::date, $5::time, 'completed', $6, $7, $8, $9,
                 'approved', 'assigned', 'approved', 'approved', $10)
         returning booking_id, reference_number`,
        [
          client.client_id,
          `${MARKER} ${route.origin}`,
          route.truck,
          date,
          route.callTime,
          route.terms,
          route.weightKg,
          route.volumeCbm,
          route.cost,
          'Palletised FMCG dry goods, shrink-wrapped',
        ],
      )
      const booking = rows[0]

      for (const [j, address] of route.dests.entries()) {
        await db.query(
          `insert into booking_destinations
             (booking_id, address, sequence_order, status, delivered_at)
           values ($1, $2, $3, 'delivered', $4::date + time '16:00')`,
          [booking.booking_id, address, j + 1, date],
        )
      }

      console.log(
        `    ${booking.reference_number}  ${date}  ${route.terms}-day  ` +
        `PHP ${route.cost.toLocaleString('en-PH')}`,
      )
    }
  }

  if (dryRun) {
    await db.query('ROLLBACK')
    console.log('\nDRY RUN — rolled back, nothing changed.')
    process.exit(0)
  }

  await db.query('COMMIT')
  console.log('\nDatabase committed.')
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error(`\nRolled back, nothing changed: ${(err as Error).message}`)
  process.exit(1)
} finally {
  db.release()
}

// The same two calls the client's own billing screen makes when it opens, so
// the periods exist and carry today's status before anyone looks.
for (const email of EMAILS) {
  const { rows } = await pool.query(
    `select c.client_id, c.billing_mode from clients c
       join users u on u.user_id = c.user_id where lower(u.email) = lower($1)`,
    [email],
  )
  const { client_id, billing_mode } = rows[0]
  await ensurePeriodsForClient(client_id, billing_mode)
  await advancePeriodStates(client_id)

  const { rows: periods } = await pool.query(
    `select to_char(period_start,'YYYY-MM-DD') s, to_char(period_end,'YYYY-MM-DD') e,
            cutoff_no, status,
            to_char(consolidation_start,'YYYY-MM-DD') c1,
            to_char(submission_start,'YYYY-MM-DD') w1,
            to_char(submission_end,'YYYY-MM-DD') w2,
            (select count(*) from bookings b
              where b.client_id = p.client_id and b.status = 'completed'
                and b.schedule_date between p.period_start and p.period_end) as deliveries
       from billing_periods p where client_id = $1 order by period_start`,
    [client_id],
  )

  console.log(`\nbilling periods for ${email} (${billing_mode}):`)
  for (const p of periods) {
    const current = p.s <= today && today <= p.e
    console.log(
      `  ${p.s}..${p.e}${p.cutoff_no ? ` c${p.cutoff_no}` : '   '}  ` +
      `${String(p.status).padEnd(22)} consolidate ${p.c1}  ` +
      `client window ${p.w1}..${p.w2}  ${p.deliveries} delivery(ies)` +
      `${current ? '   <== CURRENT, still open' : ''}`,
    )
  }
}

console.log(`\ntoday: ${today}`)
await pool.end()
