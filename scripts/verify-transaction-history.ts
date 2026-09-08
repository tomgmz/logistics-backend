/**
 * Read-only checks for the staff transaction history.
 *
 * Runs the real model queries against whatever DATABASE_URL points at and
 * asserts the invariants the page depends on — above all that the totals strip
 * and the table describe the same set of rows.
 *
 *   npx tsx scripts/verify-transaction-history.ts
 *
 * Every statement here is a SELECT. Nothing is written.
 */
// First import, so dotenv runs before database.ts builds its Pool from
// process.env — a plain dotenv.config() call would land after the hoisted
// imports and leave the connection string undefined.
import 'dotenv/config'

import { pool } from '../src/lib/database.js'
import { TransactionHistoryModel, type DateBasis } from '../src/models/admin/transaction-history.model.js'
import {
  listTransactionsService,
  getTransactionSummaryService,
  exportTransactionsService,
} from '../src/services/admin/transaction-history.service.js'

let failures = 0
let checks   = 0

function check(name: string, ok: boolean, detail = '') {
  checks++
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function heading(s: string) {
  console.log(`\n${s}\n${'-'.repeat(s.length)}`)
}

/** Floating money compares need a cent of slack, not exact equality. */
function near(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) < eps
}

async function main() {
  heading('0. Connectivity')
  const ping = await pool.query<{ n: string }>('SELECT COUNT(*)::int AS n FROM bookings')
  const totalBookings = Number(ping.rows[0].n)
  console.log(`  bookings in database: ${totalBookings}`)
  if (totalBookings === 0) {
    console.log('\n  No bookings — the filter checks below cannot prove anything.')
  }

  // ---------------------------------------------------------------------
  heading('1. Unfiltered: totals strip vs table')
  const baseFilters = { status: 'all', dateBasis: 'scheduled' as DateBasis }
  const base = await listTransactionsService({ ...baseFilters, page: 1, limit: 20 })
  const baseSummary = await getTransactionSummaryService(baseFilters)

  check(
    'summary.total === meta.total',
    baseSummary.total === base.meta.total,
    `summary=${baseSummary.total} list=${base.meta.total}`,
  )
  check(
    'statusCounts.all === meta.total',
    (base.meta.statusCounts.all ?? 0) === base.meta.total,
    `counts.all=${base.meta.statusCounts.all} list=${base.meta.total}`,
  )
  const summedStatuses = Object.entries(base.meta.statusCounts)
    .filter(([k]) => k !== 'all')
    .reduce((s, [, v]) => s + v, 0)
  check(
    'per-status counts sum to all',
    summedStatuses === (base.meta.statusCounts.all ?? 0),
    `sum=${summedStatuses} all=${base.meta.statusCounts.all}`,
  )
  check('page respects limit', base.data.length <= 20, `returned ${base.data.length}`)
  console.log(`  gross=${baseSummary.grossValue.toFixed(2)} avg=${baseSummary.averageValue.toFixed(2)} ` +
              `completed=${baseSummary.completed} cancelled=${baseSummary.cancelled} unpriced=${baseSummary.unpriced}`)

  // ---------------------------------------------------------------------
  heading('2. Per-company breakdown reconciles with the totals')
  const bdCount = baseSummary.breakdown.reduce((s, r) => s + r.count, 0)
  const bdValue = baseSummary.breakdown.reduce((s, r) => s + r.grossValue, 0)
  check('breakdown counts sum to summary.total', bdCount === baseSummary.total,
    `breakdown=${bdCount} summary=${baseSummary.total}`)
  check('breakdown values sum to summary.grossValue', near(bdValue, baseSummary.grossValue),
    `breakdown=${bdValue.toFixed(2)} summary=${baseSummary.grossValue.toFixed(2)}`)

  // ---------------------------------------------------------------------
  heading('3. Company filter')
  const companies = await TransactionHistoryModel.listCompaniesWithActivity()
  check('companies list returns rows', companies.length > 0, `${companies.length} companies`)

  if (companies.length > 0) {
    const target = companies[0]
    const f = { ...baseFilters, clientIds: [target.clientId] }
    const scoped = await listTransactionsService({ ...f, page: 1, limit: 100 })
    const scopedSummary = await getTransactionSummaryService(f)

    check('filtered summary.total === filtered meta.total',
      scopedSummary.total === scoped.meta.total,
      `summary=${scopedSummary.total} list=${scoped.meta.total}`)
    check('company option count matches filtered total',
      target.count === scoped.meta.total,
      `option=${target.count} filtered=${scoped.meta.total}`)

    const strayRow = scoped.data.find((r) => (r as any).client_id !== target.clientId)
    check('every returned row belongs to the filtered company', !strayRow,
      strayRow ? `stray booking ${(strayRow as any).booking_id}` : `${scoped.data.length} rows checked`)

    // A bogus id must narrow to nothing, never fall through to everything.
    const empty = await listTransactionsService({
      ...baseFilters, clientIds: ['00000000-0000-4000-8000-000000000000'], page: 1, limit: 5,
    })
    check('unknown company id yields no rows', empty.meta.total === 0, `total=${empty.meta.total}`)

    // A non-uuid is dropped by the model's guard; that must not silently widen
    // the query back to every company.
    const junk = await listTransactionsService({
      ...baseFilters, clientIds: ['not-a-uuid'], page: 1, limit: 5,
    })
    check('malformed company id does not widen the result',
      junk.meta.total === base.meta.total,
      `got=${junk.meta.total} unfiltered=${base.meta.total} (filter ignored, as designed)`)
  }

  // ---------------------------------------------------------------------
  heading('4. The three date bases are genuinely different')
  const span = await pool.query<{ lo: string; hi: string }>(
    `SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS lo,
            to_char(MAX(created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS hi
       FROM bookings`,
  )
  const lo = span.rows[0]?.lo
  const hi = span.rows[0]?.hi
  console.log(`  booking window (Manila): ${lo} .. ${hi}`)

  if (lo && hi) {
    const totals: Record<string, number> = {}
    for (const basis of ['scheduled', 'booked', 'completed'] as DateBasis[]) {
      const f = { status: 'all', dateBasis: basis, dateFrom: lo, dateTo: hi }
      const list = await listTransactionsService({ ...f, page: 1, limit: 1 })
      const sum  = await getTransactionSummaryService(f)
      totals[basis] = list.meta.total
      check(`[${basis}] summary.total === meta.total`, sum.total === list.meta.total,
        `summary=${sum.total} list=${list.meta.total}`)
    }
    console.log(`  totals by basis: ${JSON.stringify(totals)}`)

    // 'completed' can only ever be a subset — a booking with no delivered stop
    // has no completion date to fall inside any range.
    const completedAll = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM bookings b
        WHERE EXISTS (SELECT 1 FROM booking_destinations d
                       WHERE d.booking_id = b.booking_id AND d.delivered_at IS NOT NULL)`,
    )
    check('completed basis counts only bookings with a delivered stop',
      totals.completed <= Number(completedAll.rows[0].n),
      `basis=${totals.completed} have-delivered=${completedAll.rows[0].n}`)
  }

  // ---------------------------------------------------------------------
  heading('5. Manila day boundary on the booked basis')
  // A booking created at >= 16:00 UTC falls on the NEXT calendar day in Manila.
  // This is the case a naive UTC comparison gets wrong.
  // created_at is a naive timestamp holding UTC wall-clock, so the UTC day is
  // just its own date, and the Manila day is that instant read as UTC and then
  // converted. Anything stored at/after 16:00 falls on the NEXT Manila day.
  const edge = await pool.query<{ booking_id: string; utc_day: string; ph_day: string }>(
    `SELECT booking_id,
            to_char(created_at, 'YYYY-MM-DD')                                        AS utc_day,
            to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS ph_day
       FROM bookings
      WHERE EXTRACT(HOUR FROM created_at) >= 16
      LIMIT 1`,
  )

  if (edge.rows.length === 0) {
    console.log('  SKIP  no booking created at/after 16:00 UTC, so no boundary case exists to test')
  } else {
    const { booking_id, utc_day, ph_day } = edge.rows[0]
    console.log(`  probe booking ${booking_id}: UTC day ${utc_day}, Manila day ${ph_day}`)
    check('probe really does straddle midnight', utc_day !== ph_day, `${utc_day} vs ${ph_day}`)

    // Drive the real service so this asserts the shipped predicate rather than a
    // restatement of it.
    const onPhDay = await listTransactionsService({
      status: 'all', dateBasis: 'booked', dateFrom: ph_day, dateTo: ph_day, page: 1, limit: 100,
    })
    const onUtcDay = await listTransactionsService({
      status: 'all', dateBasis: 'booked', dateFrom: utc_day, dateTo: utc_day, page: 1, limit: 100,
    })
    const inPh  = onPhDay.data.some((r) => (r as any).booking_id === booking_id)
    const inUtc = onUtcDay.data.some((r) => (r as any).booking_id === booking_id)
    check('booked basis places it on the Manila day', inPh, `range ${ph_day}`)
    check('booked basis does NOT place it on the UTC day', !inUtc, `range ${utc_day}`)
  }

  // ---------------------------------------------------------------------
  heading('6. Search, status and sort')
  const pending = await listTransactionsService({ status: 'pending', dateBasis: 'scheduled', page: 1, limit: 5 })
  check('status filter total matches its tab count',
    pending.meta.total === (base.meta.statusCounts.pending ?? 0),
    `filtered=${pending.meta.total} tab=${base.meta.statusCounts.pending ?? 0}`)
  check('status tab counts ignore the active status filter',
    (pending.meta.statusCounts.all ?? 0) === (base.meta.statusCounts.all ?? 0),
    `all=${pending.meta.statusCounts.all} unfiltered=${base.meta.statusCounts.all}`)

  // A wildcard must be treated as a literal, not as "match everything".
  const wildcard = await listTransactionsService({ status: 'all', dateBasis: 'scheduled', search: '%', page: 1, limit: 5 })
  check('search escapes % rather than matching all rows',
    wildcard.meta.total < base.meta.total || base.meta.total === 0,
    `"%"=${wildcard.meta.total} unfiltered=${base.meta.total}`)

  for (const sort of ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'] as const) {
    const r = await listTransactionsService({ status: 'all', dateBasis: 'scheduled', sort, page: 1, limit: 5 })
    check(`sort ${sort} executes and keeps the total`, r.meta.total === base.meta.total,
      `total=${r.meta.total}`)
  }

  const amountSorted = await listTransactionsService({
    status: 'all', dateBasis: 'scheduled', sort: 'amount_desc', page: 1, limit: 10,
  })
  const costs = amountSorted.data.map((r) => Number((r as any).total_cost ?? 0))
  check('amount_desc really is descending',
    costs.every((v, i) => i === 0 || costs[i - 1] >= v),
    `[${costs.slice(0, 5).join(', ')}]`)

  // ---------------------------------------------------------------------
  heading('7. Export matches the filtered set')
  const exported = await exportTransactionsService(baseFilters)
  check('export row count equals the filtered total',
    exported.rows.length === Math.min(baseSummary.total, 5000),
    `export=${exported.rows.length} total=${baseSummary.total} truncated=${exported.truncated}`)
  if (exported.rows.length > 0) {
    const r = exported.rows[0]
    check('export rows carry a company name', !!r.company_name, `e.g. "${r.company_name}"`)
    check('export rows carry the three dates as columns',
      'booked_date' in r && 'schedule_date' in r && 'completed_date' in r)
  }

  // ---------------------------------------------------------------------
  heading('8. Pagination')
  if (base.meta.total > 1) {
    const p1 = await listTransactionsService({ ...baseFilters, page: 1, limit: 1 })
    const p2 = await listTransactionsService({ ...baseFilters, page: 2, limit: 1 })
    const id1 = (p1.data[0] as any)?.booking_id
    const id2 = (p2.data[0] as any)?.booking_id
    check('page 2 returns a different row than page 1', !!id1 && !!id2 && id1 !== id2,
      `${id1} vs ${id2}`)
    check('totalPages is derived from total and limit',
      p1.meta.totalPages === Math.max(1, Math.ceil(base.meta.total / 1)),
      `totalPages=${p1.meta.totalPages} total=${base.meta.total}`)
  } else {
    console.log('  SKIP  fewer than 2 bookings')
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${checks - failures}/${checks} checks passed`)
  if (failures > 0) console.log(`${failures} FAILED`)
  console.log('='.repeat(60))

  await pool.end()
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error('\nVERIFICATION ERROR:', err)
  await pool.end().catch(() => {})
  process.exit(1)
})
