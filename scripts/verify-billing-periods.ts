/**
 * Exercises period generation against real data.
 *
 *   npx tsx scripts/verify-billing-periods.ts          # generate + report
 *   npx tsx scripts/verify-billing-periods.ts --clean  # remove what it made
 *
 * Periods are ordinary operational records — the system creates them the moment
 * anyone opens the billing screen — so this is not destructive. --clean exists
 * so a trial run can be undone while the feature is still being built.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import {
  advancePeriodStates,
  ensurePeriodsForClient,
} from '../src/services/billing/billing-periods.service.js'
import { phDay } from '../src/lib/ph-date.js'

const clean = process.argv.includes('--clean')

const { rows: clients } = await pool.query(
  `select distinct c.client_id, c.company_name, c.billing_mode
     from clients c
     join bookings b on b.client_id = c.client_id and b.status = 'completed'`,
)

if (!clients.length) {
  console.log('No client has a completed booking — nothing to generate.')
  await pool.end()
  process.exit(0)
}

console.log(`today (PH): ${phDay()}\n`)

for (const c of clients) {
  console.log(`${c.company_name} — mode: ${c.billing_mode}`)

  if (clean) {
    const { rowCount } = await pool.query(
      `delete from billing_periods
        where client_id = $1 and status in ('draft','consolidating','awaiting_submission')`,
      [c.client_id],
    )
    console.log(`  removed ${rowCount} untouched period(s)\n`)
    continue
  }

  const created = await ensurePeriodsForClient(c.client_id, c.billing_mode)
  await advancePeriodStates(c.client_id)
  console.log(`  generated ${created} period(s)`)

  const { rows: periods } = await pool.query(
    `select to_char(period_start,'YYYY-MM-DD') s,
            to_char(period_end,'YYYY-MM-DD')   e,
            cutoff_no, status,
            to_char(submission_start,'YYYY-MM-DD') sub_from,
            to_char(submission_end,'YYYY-MM-DD')   sub_to,
            (select count(*) from bookings b
              where b.client_id = p.client_id and b.status = 'completed'
                and b.schedule_date between p.period_start and p.period_end) as deliveries
       from billing_periods p
      where client_id = $1
      order by period_start`,
    [c.client_id],
  )

  for (const p of periods) {
    const cut = p.cutoff_no ? ` cut-off ${p.cutoff_no}` : ''
    const win = p.sub_from ? `  client window ${p.sub_from}..${p.sub_to}` : ''
    const flag = Number(p.deliveries) > 0 ? `  <- ${p.deliveries} delivery(ies)` : ''
    console.log(`    ${p.s}..${p.e}${cut}  ${String(p.status).padEnd(20)}${win}${flag}`)
  }

  const actionable = periods.filter(
    (p) => Number(p.deliveries) > 0 && ['awaiting_submission', 'awaiting_client_approval'].includes(p.status),
  )
  console.log(`  ready for the client to act on: ${actionable.length}\n`)
}

await pool.end()
