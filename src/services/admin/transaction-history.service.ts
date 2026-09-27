import {
  TransactionHistoryModel,
  type TransactionFilters,
  type TransactionListQuery,
  type CompanyBreakdownRow,
  type ExportRow,
} from '../../models/admin/transaction-history.model.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'
import { logEvent } from '../../lib/log-event.js'
import { supabase } from '../../lib/supabase.js'
import { AssignmentModel } from '../../models/admin/assignment.model.js'
import TripModel from '../../models/client/trip.model.js'
import ReportModel from '../../models/driver/report.model.js'
import * as InspectionModel from '../../models/admin/truck-inspection.model.js'
import type { AssignmentWithRelations } from '../../types/assignment.types.js'
import type { TripWithStops } from '../../types/client/trip.types.js'
import type { DriverReport } from '../../types/driver/report.types.js'

/**
 * Staff transaction history. Thin over the model: clamps, derived ratios, and
 * the rollup that makes the per-company breakdown reconcile with the totals.
 *
 * No viewer argument, unlike the booking service. Every route that reaches here
 * is already restricted to staff by role plus the transaction-history module,
 * so there is no client to scope down to.
 */

/** Above this the browser is downloading a spreadsheet, not reading a page. */
export const EXPORT_ROW_CAP = 5000

export interface TransactionListMeta {
  total:        number
  page:         number
  limit:        number
  totalPages:   number
  statusCounts: Record<string, number>
}

export interface TransactionSummary {
  total:            number
  grossValue:       number
  averageValue:     number
  completed:        number
  cancelled:        number
  unpriced:         number
  cancellationRate: number
  breakdown:        CompanyBreakdownRow[]
}

export async function listTransactionsService(
  params: TransactionListQuery,
): Promise<{ data: BookingWithRelations[]; meta: TransactionListMeta }> {
  const page  = Math.max(1, params.page)
  const limit = Math.min(Math.max(1, params.limit), 100)

  const [{ rows, total }, statusCounts] = await Promise.all([
    TransactionHistoryModel.findTransactions({ ...params, page, limit }),
    TransactionHistoryModel.countByStatus(params),
  ])

  return {
    data: rows,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusCounts,
    },
  }
}

export async function getTransactionSummaryService(
  filters: TransactionFilters,
): Promise<TransactionSummary> {
  const [totals, top] = await Promise.all([
    TransactionHistoryModel.summarize(filters),
    TransactionHistoryModel.breakdownByCompany(filters, 10),
  ])

  // The breakdown shows the top companies only, so without this the rows would
  // visibly fail to add up to the gross figure sitting right above them.
  const shownCount = top.reduce((sum, r) => sum + r.count, 0)
  const shownValue = top.reduce((sum, r) => sum + r.grossValue, 0)
  const breakdown  = [...top]

  if (totals.total > shownCount) {
    breakdown.push({
      clientId:    null,
      companyName: 'Other companies',
      count:       totals.total - shownCount,
      grossValue:  Math.max(0, totals.grossValue - shownValue),
    })
  }

  return {
    total:            totals.total,
    grossValue:       totals.grossValue,
    // Averaged over every transaction in range, priced or not, so it reconciles
    // with gross / total rather than quietly using a different denominator.
    averageValue:     totals.total > 0 ? totals.grossValue / totals.total : 0,
    completed:        totals.completed,
    cancelled:        totals.cancelled,
    unpriced:         totals.unpriced,
    cancellationRate: totals.total > 0 ? totals.cancelled / totals.total : 0,
    breakdown,
  }
}

export async function listTransactionCompaniesService() {
  return TransactionHistoryModel.listCompaniesWithActivity()
}

export async function exportTransactionsService(
  filters: TransactionFilters,
): Promise<{ rows: ExportRow[]; truncated: boolean }> {
  // Ask for one past the cap so a full page tells us there was more behind it.
  const rows = await TransactionHistoryModel.findForExport(filters, EXPORT_ROW_CAP + 1)
  const truncated = rows.length > EXPORT_ROW_CAP
  const exported  = truncated ? EXPORT_ROW_CAP : rows.length

  // Thousands of rows of financial history leaving the system in one click is
  // exactly what an audit trail is for, and it was previously invisible. The
  // actor comes from the ambient request context.
  logEvent({
    log_type:    'data_export',
    action:      'transactions_exported',
    description: `Exported ${exported} transaction row(s)${truncated ? ` (capped at ${EXPORT_ROW_CAP})` : ''}; filters: ${JSON.stringify(filters)}`,
  })

  return { rows: truncated ? rows.slice(0, EXPORT_ROW_CAP) : rows, truncated }
}

export interface TransactionRecord {
  /** Crew and vehicle as assigned, including a vendor-supplied snapshot. */
  delivery:    AssignmentWithRelations | null
  /** Every run of the vehicle, each with its pickup proof and per-stop proof. */
  trips:       TripWithStops[]
  /** Incidents the driver raised against this booking, with their media. */
  reports:     DriverReport[]
  /** The passed BLOWBAGETS inspection the vehicle was assigned on. */
  inspection:  InspectionModel.TruckInspection | null
  /** Who approved/rejected, who assigned, who cancelled — with role and time. */
  approvals:   TransactionApprovals
}

export interface DecisionActor {
  name: string | null
  /** users.role the person acted in. */
  role: string | null
  at:   string | null
}

export interface TransactionApprovals {
  /** The approve/reject decision: General Manager, or Company Admin on their own authority. */
  review:     (DecisionActor & { outcome: string | null }) | null
  /** The driver-and-vehicle assignment. */
  assignment: DecisionActor | null
  /** A cancellation or Company Admin rejection. */
  cancelled:  DecisionActor | null
  /** Who confirmed completion; `auto` when it completed on its own after 3 days. */
  completion: (DecisionActor & { auto: boolean }) | null
  /** A problem the client reported instead of confirming. */
  issue:      { note: string; at: string | null } | null
}

/**
 * Resolve the decision columns into names. Tolerates a database without the
 * 20260928000000 attribution columns (answers with nothing rather than failing
 * the whole record), so this can ship ahead of the migration.
 */
async function loadApprovals(bookingId: string): Promise<TransactionApprovals> {
  const empty: TransactionApprovals = { review: null, assignment: null, cancelled: null, completion: null, issue: null }
  const { data: b, error } = await supabase
    .from('bookings')
    .select('gm_status, gm_reviewed_by, gm_reviewed_at, gm_reviewed_role, ops_assigned_by, ops_assigned_at, ops_assigned_role, cancelled_by, cancelled_at, completion_confirmed_by, completion_confirmed_role, completion_confirmed_at, completion_auto, client_issue_note, client_issue_reported_at')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (error) {
    console.error('[transaction-history] approvals unavailable', error.message)
    return empty
  }
  if (!b) return empty

  const ids = [b.gm_reviewed_by, b.ops_assigned_by, b.cancelled_by, b.completion_confirmed_by].filter((x): x is string => !!x)
  const people = new Map<string, { name: string | null; role: string | null }>()
  if (ids.length) {
    const { data: users, error: usersErr } = await supabase
      .from('users')
      .select('user_id, first_name, last_name, role')
      .in('user_id', [...new Set(ids)])
    if (usersErr) throw usersErr
    for (const u of users ?? []) {
      const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || null
      people.set(u.user_id as string, { name, role: (u.role as string) ?? null })
    }
  }

  const who = (id: string | null, at: string | null, role?: string | null): DecisionActor | null =>
    id || at
      ? { name: id ? people.get(id)?.name ?? null : null, role: role ?? (id ? people.get(id)?.role ?? null : null), at }
      : null

  const review = who(b.gm_reviewed_by, b.gm_reviewed_at, b.gm_reviewed_role)
  return {
    review:     review ? { ...review, outcome: (b.gm_status as string) ?? null } : null,
    assignment: who(b.ops_assigned_by, b.ops_assigned_at, b.ops_assigned_role),
    cancelled:  who(b.cancelled_by, b.cancelled_at),
    completion: b.completion_confirmed_at
      ? { ...who(b.completion_confirmed_by, b.completion_confirmed_at, b.completion_confirmed_role)!, auto: !!b.completion_auto }
      : null,
    issue: b.client_issue_note ? { note: b.client_issue_note as string, at: (b.client_issue_reported_at as string) ?? null } : null,
  }
}

/**
 * Everything attached to one booking that the list row does not carry: the
 * crew and vehicle, trip proof photos, driver reports and the vehicle's inspection.
 *
 * Fetched per booking when a row is opened, not joined into the list — the
 * list is paged 20 at a time and none of this is needed to render a row.
 * Returns null for an unknown booking.
 */
export async function getTransactionRecordService(bookingId: string): Promise<TransactionRecord | null> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('booking_id, created_at, fleet_return_at')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (error) throw error
  if (!booking) return null

  const [delivery, trips, reports, approvals] = await Promise.all([
    AssignmentModel.findByBookingId(bookingId),
    TripModel.findByBookingId(bookingId),
    ReportModel.findByBookingId(bookingId),
    loadApprovals(bookingId),
  ])

  // Inspections belong to the vehicle, not the booking. The one that matters is
  // the pass the vehicle was assigned on: the latest passed inspection at or
  // before the moment it went onto this booking.
  let inspection: InspectionModel.TruckInspection | null = null
  const truckId = delivery?.truck_id ?? null
  if (truckId) {
    const { data: ta, error: taErr } = await supabase
      .from('truck_assignments')
      .select('assigned_at')
      .eq('booking_id', bookingId)
      .eq('truck_id', truckId)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (taErr) throw taErr

    const assignedAt = new Date((ta?.assigned_at ?? delivery?.created_at) as string).getTime()
    const all = await InspectionModel.listForTruck(truckId, 100)
    inspection = all.find((i) => i.passed && new Date(i.inspected_at).getTime() <= assignedAt) ?? null
  }

  return { delivery, trips, reports, inspection, approvals }
}
