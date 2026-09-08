import {
  TransactionHistoryModel,
  type TransactionFilters,
  type TransactionListQuery,
  type CompanyBreakdownRow,
  type ExportRow,
} from '../../models/admin/transaction-history.model.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'

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
  return { rows: truncated ? rows.slice(0, EXPORT_ROW_CAP) : rows, truncated }
}
