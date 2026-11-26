import { pool } from '../../lib/database.js'

/**
 * The IT Administrator dashboard's logistics view (user 2026-11-26: TailAdmin's
 * logistics dashboard, "just copy the data that is in the link"). Counts and a
 * paged booking list only; no amounts (the system handles no money, 2026-11-17),
 * so the link's revenue and price figures have no equivalent here.
 *
 * Time columns differ in kind: bookings.created_at, deliveries.pickup_time and
 * booking_destinations.delivered_at are naive UTC wall-clock; bookings.delivered_at
 * and pickup_proof_at are timestamptz. Every naive one is read through
 * `AT TIME ZONE 'UTC'` first, and every time leaves here as an ISO string with
 * its zone (node-pg would read a naive value as the server's local time).
 */

const MANILA = `'Asia/Manila'`
const naiveToTz = (col: string) => `(${col} AT TIME ZONE 'UTC')`

export type Period = 'monthly' | 'quarterly' | 'annually'
export const PERIODS: readonly Period[] = ['monthly', 'quarterly', 'annually']

const PERIOD_SQL: Record<Period, { unit: string; step: string; points: number }> = {
  monthly:   { unit: 'month',   step: '1 month',  points: 12 },
  quarterly: { unit: 'quarter', step: '3 months', points: 8 },
  annually:  { unit: 'year',    step: '1 year',   points: 5 },
}

/** The tabs over the activity table, as the link's (All, Delivered, In-Transit, Pending, Processing). */
export type ActivityTab = 'all' | 'delivered' | 'in_transit' | 'pending' | 'processing'
export const ACTIVITY_TABS: readonly ActivityTab[] = ['all', 'delivered', 'in_transit', 'pending', 'processing']

const TAB_STATUSES: Record<Exclude<ActivityTab, 'all'>, string[]> = {
  delivered:  ['delivered', 'completed'],
  in_transit: ['in_transit'],
  // Waiting for the General Manager.
  pending:    ['pending'],
  // Approved and being planned or assigned, not on the road yet.
  processing: ['approved', 'assigned'],
}

export interface ActivityRow {
  booking_id:       string
  reference_number: string | null
  category:         string | null
  company:          string
  origin:           string | null
  destination:      string | null
  stops:            number
  status:           string
  schedule_date:    string | null
  /** Left for the pick-up (Start Navigation). */
  started_at:       string | null
  /** Loading proof at the pick-up. */
  picked_up_at:     string | null
  /** The driver finished the last drop-off. */
  delivered_at:     string | null
  driver:           string | null
  plate:            string | null
  /** The fields the web's BookingStatusTag reads for its sub-tags (Paused, Delayed, Late Start…). */
  tag:              Record<string, unknown>
}

/**
 * One booking per row with everything the table and the tracking card show.
 * $-placeholders are numbered by the caller's WHERE; this is only the SELECT
 * list and joins.
 */
const ROW_SQL = `
  SELECT b.booking_id,
         b.reference_number,
         b.status::text AS status,
         to_char(b.schedule_date, 'YYYY-MM-DD') AS schedule_date,
         b.origin,
         COALESCE(NULLIF(c.registered_name, ''), NULLIF(c.company_name, ''), 'Unknown client') AS company,
         dest.address  AS destination,
         dest.stops,
         cargo.names   AS categories,
         to_char(${naiveToTz('d.pickup_time')} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
         to_char(b.pickup_proof_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS picked_up_at,
         to_char(b.delivered_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
         COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), NULLIF(d.vendor_driver_name, '')) AS driver,
         COALESCE(t.plate_number, NULLIF(d.vendor_vehicle_plate, '')) AS plate,
         json_build_object(
           'paused_at', b.paused_at, 'pause_reason', b.pause_reason,
           'breakdown_reported_at', b.breakdown_reported_at, 'late_start_for', b.late_start_for,
           'delayed_since', b.delayed_since, 'delay_minutes', b.delay_minutes, 'delay_max_minutes', b.delay_max_minutes,
           'resubmission_count', b.resubmission_count,
           'client_issue_note', b.client_issue_note,
           'client_issue_reported_at', b.client_issue_reported_at, 'client_issue_resolved_at', b.client_issue_resolved_at,
           'booking_destinations', dest.statuses
         ) AS tag
    FROM bookings b
    LEFT JOIN clients c ON c.client_id = b.client_id
    LEFT JOIN LATERAL (
      SELECT dd.pickup_time, dd.driver_id, dd.truck_id, dd.vendor_driver_name, dd.vendor_vehicle_plate
        FROM deliveries dd
       WHERE dd.booking_id = b.booking_id
       ORDER BY dd.created_at DESC
       LIMIT 1
    ) d ON true
    LEFT JOIN drivers dr ON dr.driver_id = d.driver_id
    LEFT JOIN users   u  ON u.user_id   = dr.user_id
    LEFT JOIN trucks  t  ON t.truck_id  = d.truck_id
    LEFT JOIN LATERAL (
      SELECT (ARRAY_AGG(bd.address ORDER BY bd.sequence_order DESC))[1] AS address, COUNT(*)::int AS stops,
             COALESCE(json_agg(json_build_object('status', bd.status)), '[]'::json) AS statuses
        FROM booking_destinations bd
       WHERE bd.booking_id = b.booking_id
    ) dest ON true
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(DISTINCT x.name) AS names
        FROM (
          SELECT COALESCE(NULLIF(TRIM(ci.commodity_text), ''), cm.name) AS name
            FROM booking_cargo_items ci
            LEFT JOIN commodities cm ON cm.commodity_id = ci.commodity_id
           WHERE ci.booking_id = b.booking_id
        ) x
       WHERE x.name IS NOT NULL
    ) cargo ON true
`

interface RawRow extends Omit<ActivityRow, 'category'> { categories: string[] | null }

function toRow(r: RawRow): ActivityRow {
  const names = (r.categories ?? []).filter(Boolean).sort((a, b) => a.localeCompare(b))
  const { categories: _drop, ...rest } = r
  return {
    ...rest,
    category: names.length === 0 ? null : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`,
  }
}

// ── Cards, chart and the tracked delivery ───────────────────────────────────

export async function getOverview(period: Period) {
  const p = PERIOD_SQL[period]
  const nowManila = `(now() AT TIME ZONE ${MANILA})`

  const [totals, vehicles, stats, tracked] = await Promise.all([
    pool.query<{
      bookings: number; booked_30d: number; booked_prev_30d: number
      in_transit: number; delivered: number; delivered_30d: number; delivered_prev_30d: number
    }>(`
      SELECT COUNT(*)::int AS bookings,
             COUNT(*) FILTER (WHERE ${naiveToTz('created_at')} >= now() - interval '30 days')::int AS booked_30d,
             COUNT(*) FILTER (WHERE ${naiveToTz('created_at')} >= now() - interval '60 days'
                                AND ${naiveToTz('created_at')} <  now() - interval '30 days')::int AS booked_prev_30d,
             COUNT(*) FILTER (WHERE status = 'in_transit')::int AS in_transit,
             COUNT(*) FILTER (WHERE status IN ('delivered', 'completed'))::int AS delivered,
             COUNT(*) FILTER (WHERE delivered_at >= now() - interval '30 days')::int AS delivered_30d,
             COUNT(*) FILTER (WHERE delivered_at >= now() - interval '60 days'
                                AND delivered_at <  now() - interval '30 days')::int AS delivered_prev_30d
        FROM bookings`),
    // The company fleet (vendor vehicles are typed onto a booking, never in trucks).
    pool.query<{ total: number; on_route: number }>(`
      SELECT COUNT(*) FILTER (WHERE status <> 'archived')::int AS total,
             COUNT(*) FILTER (WHERE status = 'in_use')::int    AS on_route
        FROM trucks`),
    pool.query<{ start: string; booked: number; started: number; delivered: number }>(`
      WITH s AS (
        SELECT generate_series(
                 date_trunc($1, ${nowManila}) - ($2::int - 1) * $3::interval,
                 date_trunc($1, ${nowManila}),
                 $3::interval) AS k
      ),
      booked AS (
        SELECT date_trunc($1, ${naiveToTz('created_at')} AT TIME ZONE ${MANILA}) AS k, COUNT(*)::int AS n
          FROM bookings GROUP BY 1
      ),
      started AS (
        SELECT date_trunc($1, t) AS k, COUNT(*)::int AS n
          FROM (SELECT MIN(${naiveToTz('pickup_time')}) AT TIME ZONE ${MANILA} AS t
                  FROM deliveries WHERE pickup_time IS NOT NULL GROUP BY booking_id) x
         GROUP BY 1
      ),
      delivered AS (
        SELECT date_trunc($1, delivered_at AT TIME ZONE ${MANILA}) AS k, COUNT(*)::int AS n
          FROM bookings WHERE delivered_at IS NOT NULL GROUP BY 1
      )
      SELECT to_char(s.k, 'YYYY-MM-DD') AS start,
             COALESCE(booked.n, 0)    AS booked,
             COALESCE(started.n, 0)   AS started,
             COALESCE(delivered.n, 0) AS delivered
        FROM s
        LEFT JOIN booked    ON booked.k    = s.k
        LEFT JOIN started   ON started.k   = s.k
        LEFT JOIN delivered ON delivered.k = s.k
       ORDER BY s.k`, [p.unit, p.points, p.step]),
    // The link's "last viewed delivery": the delivery on the road that started
    // most recently, else the last one that ran. The web swaps it for any row
    // picked in the activity table.
    pool.query<RawRow>(`
      ${ROW_SQL}
       WHERE b.status IN ('in_transit', 'delivered', 'completed', 'failed') AND d.pickup_time IS NOT NULL
       ORDER BY (b.status = 'in_transit') DESC, d.pickup_time DESC
       LIMIT 1`),
  ])

  const buckets = stats.rows
  return {
    generated_at: new Date().toISOString(),
    totals:       totals.rows[0],
    vehicles:     vehicles.rows[0],
    statistics: {
      period,
      buckets,
      delivered_in_range: buckets.reduce((a, b) => a + b.delivered, 0),
    },
    tracked: tracked.rows[0] ? toRow(tracked.rows[0]) : null,
  }
}

// ── Activity table ──────────────────────────────────────────────────────────

export interface ActivityQuery {
  tab:      ActivityTab
  search:   string
  dateFrom: string | null
  dateTo:   string | null
  page:     number
  limit:    number
}

export async function listActivities(q: ActivityQuery) {
  const params: unknown[] = []
  const where: string[] = []

  const search = q.search.trim()
  if (search) {
    params.push(`%${search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`)
    const i = params.length
    where.push(`(b.reference_number ILIKE $${i} ESCAPE '\\' OR COALESCE(c.company_name, '') ILIKE $${i} ESCAPE '\\'
      OR COALESCE(c.registered_name, '') ILIKE $${i} ESCAPE '\\' OR b.origin ILIKE $${i} ESCAPE '\\')`)
  }
  // The day the booking runs (schedule_date is a plain date: no zone to convert).
  if (q.dateFrom) { params.push(q.dateFrom); where.push(`b.schedule_date >= $${params.length}::date`) }
  if (q.dateTo)   { params.push(q.dateTo);   where.push(`b.schedule_date <= $${params.length}::date`) }

  // Tab counts under the same search and dates, without the tab itself.
  const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const countsP = pool.query<{ status: string; n: number }>(
    `SELECT b.status::text AS status, COUNT(*)::int AS n
       FROM bookings b LEFT JOIN clients c ON c.client_id = b.client_id
       ${baseWhere} GROUP BY 1`, params)

  const listParams = [...params]
  const listWhere = [...where]
  if (q.tab !== 'all') {
    listParams.push(TAB_STATUSES[q.tab])
    listWhere.push(`b.status::text = ANY($${listParams.length}::text[])`)
  }
  const whereSql = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : ''
  const limit  = Math.min(Math.max(1, q.limit), 100)
  const page   = Math.max(1, q.page)

  const [counts, total, rows] = await Promise.all([
    countsP,
    pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM bookings b LEFT JOIN clients c ON c.client_id = b.client_id ${whereSql}`, listParams),
    pool.query<RawRow>(
      `${ROW_SQL} ${whereSql}
        ORDER BY b.created_at DESC, b.booking_id DESC
        LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
      [...listParams, limit, (page - 1) * limit]),
  ])

  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n])) as Record<string, number>
  const sum = (s: string[]) => s.reduce((a, k) => a + (byStatus[k] ?? 0), 0)
  const n = total.rows[0]?.n ?? 0

  return {
    data: rows.rows.map(toRow),
    meta: { page, limit, total: n, totalPages: Math.max(1, Math.ceil(n / limit)) },
    counts: {
      all:        Object.values(byStatus).reduce((a, b) => a + b, 0),
      delivered:  sum(TAB_STATUSES.delivered),
      in_transit: sum(TAB_STATUSES.in_transit),
      pending:    sum(TAB_STATUSES.pending),
      processing: sum(TAB_STATUSES.processing),
    } satisfies Record<ActivityTab, number>,
  }
}
