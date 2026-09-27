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
  /** BLOWBAGETS inspections of the assigned vehicle that cover this job. */
  inspections: InspectionModel.TruckInspection[]
}

/**
 * Everything attached to one booking that the list row does not carry: the
 * crew and vehicle, trip proof photos, driver reports and vehicle inspections.
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

  const [delivery, trips, reports] = await Promise.all([
    AssignmentModel.findByBookingId(bookingId),
    TripModel.findByBookingId(bookingId),
    ReportModel.findByBookingId(bookingId),
  ])

  // Inspections belong to the vehicle, not the booking, so the ones that matter
  // are picked by time: the last one before the booking existed (what the truck
  // was assigned on) plus every one up to the fleet return.
  let inspections: InspectionModel.TruckInspection[] = []
  const truckId = delivery?.truck_id ?? null
  if (truckId) {
    const all   = await InspectionModel.listForTruck(truckId, 100)
    const start = new Date(booking.created_at as string).getTime()
    const end   = booking.fleet_return_at ? new Date(booking.fleet_return_at as string).getTime() : Date.now()
    const at    = (i: InspectionModel.TruckInspection) => new Date(i.inspected_at).getTime()
    const during = all.filter((i) => at(i) >= start && at(i) <= end)
    const prior  = all.find((i) => at(i) < start)
    inspections = [...(prior ? [prior] : []), ...during.reverse()]
  }

  return { delivery, trips, reports, inspections }
}
