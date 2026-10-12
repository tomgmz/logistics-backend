import { supabase } from '../../lib/supabase.js'
import { phDay } from '../../lib/ph-date.js'
import { getAllTrucks } from './truck.service.js'

/**
 * The staff dashboards: what is waiting on each desk, plus the Company
 * Administrator's analytics.
 *
 * One read for every staff role. The web picks what each role sees (the General
 * Manager's approvals, Operations' assignments and problems, the Fleet Manager's
 * vehicles); everything here is counts and short lists of references, nothing a
 * staff member couldn't already open in their own modules.
 */

const DAY_MS        = 24 * 60 * 60 * 1000
const SERIES_DAYS   = 14
const TOP_CLIENT_WINDOW_DAYS = 30
const LIST_LIMIT    = 6

interface BookingRow {
  booking_id:               string
  reference_number:         string | null
  status:                   string
  gm_status:                string | null
  origin:                   string | null
  schedule_date:            string | null
  call_time:                string | null
  created_at:               string
  delivered_at:             string | null
  completion_confirmed_at:  string | null
  client_issue_reported_at: string | null
  client_issue_resolved_at: string | null
  fleet_return_at:          string | null
  clients:                  { company_name: string | null } | { company_name: string | null }[] | null
}

export interface DashboardBooking {
  booking_id:       string
  reference_number: string | null
  client:           string | null
  origin:           string | null
  schedule_date:    string | null
  call_time:        string | null
  status:           string
}

export interface DashboardVehicle {
  truck_id:     string
  plate_number: string
  reason:       string
}

function toItem(b: BookingRow): DashboardBooking {
  const client = Array.isArray(b.clients) ? b.clients[0] : b.clients
  return {
    booking_id:       b.booking_id,
    reference_number: b.reference_number,
    client:           client?.company_name ?? null,
    origin:           b.origin,
    schedule_date:    b.schedule_date,
    call_time:        b.call_time,
    status:           b.status,
  }
}

function bySchedule(a: BookingRow, b: BookingRow): number {
  return `${a.schedule_date ?? ''} ${a.call_time ?? ''}`.localeCompare(`${b.schedule_date ?? ''} ${b.call_time ?? ''}`)
}

/** Count plus the first few, soonest first. */
function queue(rows: BookingRow[]) {
  return { count: rows.length, items: [...rows].sort(bySchedule).slice(0, LIST_LIMIT).map(toItem) }
}

async function loadBookings(): Promise<BookingRow[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      booking_id, reference_number, status, gm_status, origin, schedule_date, call_time,
      created_at, delivered_at, completion_confirmed_at,
      client_issue_reported_at, client_issue_resolved_at, fleet_return_at,
      clients ( company_name )
    `)
  if (error) throw error
  return (data ?? []) as unknown as BookingRow[]
}

async function openDriverReports(): Promise<number> {
  const { count, error } = await supabase
    .from('driver_reports')
    .select('report_id', { count: 'exact', head: true })
    .in('status', ['reported', 'acknowledged'])
  if (error) throw error
  return count ?? 0
}

async function flaggedVendorDrivers(): Promise<number> {
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id, users!drivers_user_id_fkey!inner ( status )')
    .eq('is_external', true)
    .eq('users.status', 'inactive')
  if (error) throw error
  return (data ?? []).length
}

/** `YYYY-MM-DD` in PH time for `days` days back from today, oldest first. */
function lastDays(days: number): string[] {
  const now = Date.now()
  return Array.from({ length: days }, (_, i) => phDay(now - (days - 1 - i) * DAY_MS))
}

export async function getStaffDashboard() {
  const [bookings, trucks, reports, flaggedVendors] = await Promise.all([
    loadBookings(),
    getAllTrucks(),
    openDriverReports(),
    flaggedVendorDrivers(),
  ])

  const today    = phDay()
  const tomorrow = phDay(Date.now() + DAY_MS)

  const gmPending      = bookings.filter((b) => b.status === 'pending' && b.gm_status === 'pending')
  const opsPending     = bookings.filter((b) => b.status === 'approved')
  const dispatchToday  = bookings.filter((b) => b.status === 'assigned' && b.schedule_date === today)
  const dispatchTomorrow = bookings.filter((b) => b.status === 'assigned' && b.schedule_date === tomorrow)
  const inTransit      = bookings.filter((b) => b.status === 'in_transit')
  const openIssues     = bookings.filter((b) =>
    b.status === 'delivered' && !!b.client_issue_reported_at && !b.client_issue_resolved_at)
  const awaitingClient = bookings.filter((b) =>
    b.status === 'delivered' && !(b.client_issue_reported_at && !b.client_issue_resolved_at))
  const awaitingReturn = bookings.filter((b) =>
    (b.status === 'delivered' || b.status === 'completed') && !b.fleet_return_at && !!b.delivered_at)

  // Vehicles, with the reason each one needs a look. A vehicle is listed once,
  // under its most pressing reason.
  const live = (trucks as any[]).filter((t) => t.status !== 'archived')
  const vehicles: Record<string, DashboardVehicle[]> = {
    return_odometer_due: [], recheck_due: [], failed_inspection: [], service_overdue: [], service_due_soon: [],
  }
  for (const t of live) {
    const item = (reason: string) => ({ truck_id: t.truck_id, plate_number: t.plate_number, reason })
    const latest = t.latest_inspection
    if (t.return_odometer_due) vehicles.return_odometer_due.push(item('Return odometer due'))
    if (latest && !latest.passed) vehicles.failed_inspection.push(item('Failed BLOWBAGETS'))
    else if (!latest || t.status === 'recheck_due' ||
             (t.last_fleet_return_at && latest.inspected_at <= t.last_fleet_return_at)) {
      vehicles.recheck_due.push(item(latest ? 'BLOWBAGETS re-check due' : 'Never inspected'))
    }
    if (t.service_status?.state === 'overdue')  vehicles.service_overdue.push(item('Service overdue'))
    if (t.service_status?.state === 'due_soon') vehicles.service_due_soon.push(item('Service due soon'))
  }
  const fleetStatus = live.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1
    return acc
  }, {})

  // Analytics (Company Administrator): the last two weeks of bookings created
  // and delivered, the status mix, and the busiest clients this month.
  const days    = lastDays(SERIES_DAYS)
  const created = new Map(days.map((d) => [d, 0]))
  const delivered = new Map(days.map((d) => [d, 0]))
  for (const b of bookings) {
    const c = phDay(new Date(b.created_at))
    if (created.has(c)) created.set(c, created.get(c)! + 1)
    if (b.delivered_at) {
      const d = phDay(new Date(b.delivered_at))
      if (delivered.has(d)) delivered.set(d, delivered.get(d)! + 1)
    }
  }
  const statusMix = bookings.reduce<Record<string, number>>((acc, b) => {
    acc[b.status] = (acc[b.status] ?? 0) + 1
    return acc
  }, {})
  const since   = Date.now() - TOP_CLIENT_WINDOW_DAYS * DAY_MS
  const byClient = new Map<string, number>()
  for (const b of bookings) {
    if (Date.parse(b.created_at) < since) continue
    const name = toItem(b).client ?? 'Unknown client'
    byClient.set(name, (byClient.get(name) ?? 0) + 1)
  }

  return {
    generated_at: new Date().toISOString(),
    queues: {
      gm_pending:        queue(gmPending),
      ops_pending:       queue(opsPending),
      dispatch_today:    queue(dispatchToday),
      dispatch_tomorrow: queue(dispatchTomorrow),
      in_transit:        queue(inTransit),
      open_issues:       queue(openIssues),
      awaiting_client:   queue(awaitingClient),
      awaiting_return:   queue(awaitingReturn),
    },
    vehicles: {
      total:   live.length,
      status:  fleetStatus,
      ...Object.fromEntries(Object.entries(vehicles).map(([k, v]) => [k, { count: v.length, items: v.slice(0, LIST_LIMIT) }])),
    },
    open_driver_reports:    reports,
    flagged_vendor_drivers: flaggedVendors,
    analytics: {
      series:      days.map((d) => ({ day: d, created: created.get(d)!, delivered: delivered.get(d)! })),
      status_mix:  statusMix,
      top_clients: [...byClient.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([client, count]) => ({ client, count })),
      totals: {
        bookings:  bookings.length,
        completed: statusMix.completed ?? 0,
        cancelled: statusMix.cancelled ?? 0,
      },
    },
  }
}
