import { supabase } from '../../lib/supabase.js'
import { pool } from '../../lib/database.js'
import { BOOKING_WITH_RELATIONS_SELECT } from '../client/booking.model.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'

/**
 * Staff-facing transaction history: every company's bookings, read as
 * transactions.
 *
 * The client portal's "Transaction History" is a booking history, so this is the
 * same data widened past a single client rather than a separate ledger. There
 * are no money documents behind it: `bookings.total_cost` is the only figure,
 * and since reverse billing was removed nothing writes that column.
 *
 * Everything below filters through one `buildWhere`. That is deliberate: the
 * page shows a totals strip and a per-company rollup above the rows, and if the
 * list and the aggregates ever built their predicates separately they would
 * drift, leaving a header that contradicts the table under it.
 */

export type DateBasis = 'scheduled' | 'booked' | 'completed'
export type SortKey   = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'

export interface TransactionFilters {
  status?:    string | null
  search?:    string | null
  clientIds?: string[] | null
  dateBasis?: DateBasis
  dateFrom?:  string | null
  dateTo?:    string | null
}

export interface TransactionListQuery extends TransactionFilters {
  page:  number
  limit: number
  sort?: SortKey
}

export interface TransactionSummaryRow {
  total:       number
  grossValue:  number
  completed:   number
  cancelled:   number
  unpriced:    number
}

export interface CompanyBreakdownRow {
  clientId:    string | null
  companyName: string
  count:       number
  grossValue:  number
}

export interface CompanyOptionRow {
  clientId:    string
  companyName: string
  count:       number
}

const FROM_SQL = `
  FROM bookings b
  LEFT JOIN clients c ON c.client_id = b.client_id
`

// `registered_name` is the BIR-registered entity and takes precedence over the
// trading name: the BIR-registered entity is the one a company is invoiced as.
const COMPANY_NAME_SQL = `COALESCE(NULLIF(c.registered_name, ''), NULLIF(c.company_name, ''), 'Unknown client')`

// The moment a booking actually finished: its last delivered stop. `bookings`
// has no completed_at column, and `updated_at` moves for any edit, so this is
// the only honest answer. A booking with no delivered stop yields NULL and so
// falls out of a completed-basis range, which is correct — it never completed.
const COMPLETED_AT_SQL = `(
  SELECT MAX(d.delivered_at)
    FROM booking_destinations d
   WHERE d.booking_id = b.booking_id
)`

/**
 * Read a naive timestamp column as the Manila moment it stands for.
 *
 * `bookings.created_at` and `booking_destinations.delivered_at` are
 * `timestamp without time zone` holding UTC wall-clock, not `timestamptz`. On
 * such a column a bare `AT TIME ZONE 'Asia/Manila'` means "interpret this as
 * Manila local time and convert away from it", which moves the value eight
 * hours in the wrong direction: a booking stored at 16:58 UTC — Manila 00:58
 * the next day — comes back dated to the previous day.
 *
 * The first conversion states what the stored value actually is; the second
 * moves it to Manila. `schedule_date` needs none of this: it is a plain `date`
 * and is already the calendar day it claims to be.
 */
function asManila(expr: string): string {
  return `((${expr}) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Whitelist, never interpolation — `sort` arrives from the query string.
const SORT_SQL: Record<SortKey, string> = {
  date_desc:   'b.created_at DESC',
  date_asc:    'b.created_at ASC',
  amount_desc: 'b.total_cost DESC NULLS LAST',
  amount_asc:  'b.total_cost ASC NULLS LAST',
}

/**
 * The one predicate builder. Returns positional params in the order they were
 * pushed, so callers append LIMIT/OFFSET at `params.length + 1` onwards.
 */
function buildWhere(f: TransactionFilters): { whereSql: string; params: unknown[] } {
  const params: unknown[] = []
  const where:  string[]  = []

  const clientIds = (f.clientIds ?? []).filter((id) => UUID_RE.test(id))
  if (clientIds.length > 0) {
    params.push(clientIds)
    where.push(`b.client_id = ANY($${params.length}::uuid[])`)
  }

  const status = (f.status ?? 'all').trim().toLowerCase()
  if (status && status !== 'all') {
    params.push(status)
    where.push(`b.status = $${params.length}`)
  }

  const search = (f.search ?? '').trim()
  if (search) {
    const esc = `%${search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    params.push(esc)
    const i = params.length
    where.push(`(
      b.origin ILIKE $${i} ESCAPE '\\' OR
      b.truck_type_needed ILIKE $${i} ESCAPE '\\' OR
      b.booking_id::text ILIKE $${i} ESCAPE '\\' OR
      b.reference_number ILIKE $${i} ESCAPE '\\' OR
      COALESCE(c.company_name, '') ILIKE $${i} ESCAPE '\\' OR
      COALESCE(c.registered_name, '') ILIKE $${i} ESCAPE '\\'
    )`)
  }

  // A booking carries three meaningful dates, so the caller says which one the
  // range applies to. schedule_date is a plain `date` and compares directly;
  // the other two are naive UTC timestamps and go through asManila first.
  const basis = f.dateBasis ?? 'scheduled'
  const dateExpr =
    basis === 'booked'    ? `${asManila('b.created_at')}::date`
  : basis === 'completed' ? `${asManila(COMPLETED_AT_SQL)}::date`
  :                         `b.schedule_date`

  if (f.dateFrom) {
    params.push(f.dateFrom)
    where.push(`${dateExpr} >= $${params.length}::date`)
  }
  if (f.dateTo) {
    params.push(f.dateTo)
    where.push(`${dateExpr} <= $${params.length}::date`)
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  }
}

/**
 * One page of transactions. Two-phase like the booking list: raw SQL decides
 * which rows and in what order (it needs the clients join and the date
 * expressions above, which PostgREST cannot express), then Supabase hydrates
 * them with the full relation tree the detail panel renders.
 */
async function findTransactions(
  q: TransactionListQuery,
): Promise<{ rows: BookingWithRelations[]; total: number }> {
  const page   = Math.max(1, q.page)
  const limit  = Math.min(Math.max(1, q.limit), 100)
  const offset = (page - 1) * limit

  const { whereSql, params } = buildWhere(q)
  const orderSql = SORT_SQL[q.sort ?? 'date_desc'] ?? SORT_SQL.date_desc

  const countResult = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n ${FROM_SQL} ${whereSql}`,
    params,
  )
  const total = parseInt(countResult.rows[0]?.n ?? '0', 10) || 0

  const limitIdx  = params.length + 1
  const offsetIdx = params.length + 2
  const idsResult = await pool.query<{ booking_id: string }>(
    `SELECT b.booking_id
     ${FROM_SQL}
     ${whereSql}
     ORDER BY ${orderSql}, b.booking_id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, limit, offset],
  )

  const ids = idsResult.rows.map((r) => r.booking_id)
  if (ids.length === 0) return { rows: [], total }

  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_WITH_RELATIONS_SELECT)
    .in('booking_id', ids)

  if (error) throw error

  // Supabase returns them in its own order; re-apply the SQL ordering.
  const byId = new Map((data ?? []).map((row: any) => [row.booking_id as string, row]))
  const rows = ids.map((id) => byId.get(id)).filter(Boolean) as unknown as BookingWithRelations[]

  return { rows, total }
}

/**
 * The totals strip. Money is cast to float8 rather than numeric on purpose:
 * node-postgres hands `numeric` back as a string to protect precision, so a
 * numeric SUM arrives as "412300.00" and concatenates instead of adding. At
 * peso magnitudes a double is exact enough for a display aggregate, and the
 * per-row values it is derived from are never touched.
 */
async function summarize(f: TransactionFilters): Promise<TransactionSummaryRow> {
  const { whereSql, params } = buildWhere(f)

  const result = await pool.query<{
    total: string; gross_value: string; completed: string; cancelled: string; unpriced: string
  }>(
    `SELECT COUNT(*)::int                                             AS total,
            COALESCE(SUM(b.total_cost), 0)::float8                    AS gross_value,
            COUNT(*) FILTER (WHERE b.status = 'completed')::int       AS completed,
            COUNT(*) FILTER (WHERE b.status = 'cancelled')::int       AS cancelled,
            COUNT(*) FILTER (WHERE b.total_cost IS NULL
                                OR b.total_cost = 0)::int             AS unpriced
     ${FROM_SQL}
     ${whereSql}`,
    params,
  )

  const row = result.rows[0]
  return {
    total:      Number(row?.total       ?? 0),
    grossValue: Number(row?.gross_value ?? 0),
    completed:  Number(row?.completed   ?? 0),
    cancelled:  Number(row?.cancelled   ?? 0),
    unpriced:   Number(row?.unpriced    ?? 0),
  }
}

/** Status counts for the tab bar, under the same filters as everything else. */
async function countByStatus(f: TransactionFilters): Promise<Record<string, number>> {
  // The tab bar's own selection must not narrow its counts, or picking a tab
  // would zero every other one.
  const { whereSql, params } = buildWhere({ ...f, status: 'all' })

  const result = await pool.query<{ status: string; n: string }>(
    `SELECT b.status::text AS status, COUNT(*)::int AS n
     ${FROM_SQL}
     ${whereSql}
     GROUP BY b.status`,
    params,
  )

  const out: Record<string, number> = {}
  let all = 0
  for (const row of result.rows) {
    const n = parseInt(row.n, 10) || 0
    out[row.status] = n
    all += n
  }
  out.all = all
  return out
}

/** Top companies in the filtered range. The caller rolls up the remainder. */
async function breakdownByCompany(
  f: TransactionFilters,
  limit = 10,
): Promise<CompanyBreakdownRow[]> {
  const { whereSql, params } = buildWhere(f)

  const result = await pool.query<{
    client_id: string | null; company_name: string; n: string; gross_value: string
  }>(
    `SELECT b.client_id                              AS client_id,
            ${COMPANY_NAME_SQL}                      AS company_name,
            COUNT(*)::int                            AS n,
            COALESCE(SUM(b.total_cost), 0)::float8   AS gross_value
     ${FROM_SQL}
     ${whereSql}
     GROUP BY b.client_id, c.registered_name, c.company_name
     ORDER BY COALESCE(SUM(b.total_cost), 0) DESC, COUNT(*) DESC
     LIMIT $${params.length + 1}`,
    [...params, limit],
  )

  return result.rows.map((r) => ({
    clientId:    r.client_id,
    companyName: r.company_name,
    count:       Number(r.n),
    grossValue:  Number(r.gross_value),
  }))
}

/**
 * Options for the company filter. Only companies that actually have bookings —
 * offering one with nothing behind it is a dead end for the person filtering.
 */
async function listCompaniesWithActivity(): Promise<CompanyOptionRow[]> {
  const result = await pool.query<{ client_id: string; company_name: string; n: string }>(
    `SELECT b.client_id           AS client_id,
            ${COMPANY_NAME_SQL}   AS company_name,
            COUNT(*)::int         AS n
     ${FROM_SQL}
     WHERE b.client_id IS NOT NULL
     GROUP BY b.client_id, c.registered_name, c.company_name
     ORDER BY ${COMPANY_NAME_SQL} ASC`,
  )

  return result.rows.map((r) => ({
    clientId:    r.client_id,
    companyName: r.company_name,
    count:       Number(r.n),
  }))
}

/**
 * Flat rows for the CSV export. Deliberately not the hydrated relation tree:
 * this is one query with no per-row fan-out, so a few thousand rows stay cheap.
 */
export interface ExportRow {
  reference_number: string | null
  company_name:     string
  status:           string
  booked_date:      string | null
  schedule_date:    string | null
  completed_date:   string | null
  origin:           string | null
  destinations:     string | null
  truck_type:       string | null
  total_cost:       number | null
}

async function findForExport(f: TransactionFilters, cap: number): Promise<ExportRow[]> {
  const { whereSql, params } = buildWhere(f)

  const result = await pool.query<ExportRow & { total_cost: string | null }>(
    `SELECT b.reference_number,
            ${COMPANY_NAME_SQL}                                          AS company_name,
            b.status::text                                               AS status,
            to_char(${asManila('b.created_at')}, 'YYYY-MM-DD')            AS booked_date,
            to_char(b.schedule_date, 'YYYY-MM-DD')                       AS schedule_date,
            to_char(${asManila(COMPLETED_AT_SQL)}, 'YYYY-MM-DD')          AS completed_date,
            b.origin,
            (
              SELECT string_agg(d.address, ' | ' ORDER BY d.sequence_order)
                FROM booking_destinations d
               WHERE d.booking_id = b.booking_id
            )                                                            AS destinations,
            b.truck_type_needed                                          AS truck_type,
            b.total_cost
     ${FROM_SQL}
     ${whereSql}
     ORDER BY b.created_at DESC
     LIMIT $${params.length + 1}`,
    [...params, cap],
  )

  return result.rows.map((r) => ({
    ...r,
    total_cost: r.total_cost === null ? null : Number(r.total_cost),
  }))
}

export const TransactionHistoryModel = {
  findTransactions,
  summarize,
  countByStatus,
  breakdownByCompany,
  listCompaniesWithActivity,
  findForExport,
}
