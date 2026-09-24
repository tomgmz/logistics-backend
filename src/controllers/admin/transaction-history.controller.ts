import { Request, Response } from 'express'
import { z } from 'zod'
import {
  listTransactionsService,
  getTransactionSummaryService,
  listTransactionCompaniesService,
  exportTransactionsService,
} from '../../services/admin/transaction-history.service.js'
import type {
  TransactionFilters,
  DateBasis,
  SortKey,
} from '../../models/admin/transaction-history.model.js'

/**
 * Staff transaction history.
 *
 * The `validate` middleware only ever reads req.body, so query strings are
 * parsed here instead.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/

const querySchema = z.object({
  page:       z.coerce.number().int().positive().optional(),
  limit:      z.coerce.number().int().positive().max(100).optional(),
  status:     z.string().trim().toLowerCase().optional(),
  search:     z.string().trim().max(200).optional(),
  client_ids: z.string().trim().optional(),
  date_basis: z.enum(['scheduled', 'booked', 'completed']).optional(),
  date_from:  z.string().regex(DAY, 'date_from must be YYYY-MM-DD').optional(),
  date_to:    z.string().regex(DAY, 'date_to must be YYYY-MM-DD').optional(),
  sort:       z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).optional(),
})

type ParsedQuery = z.infer<typeof querySchema>

/**
 * Parse once, or answer 400. Returns null after responding so each handler can
 * simply bail.
 */
function parseQuery(req: Request, res: Response): ParsedQuery | null {
  // Repeated params (?client_ids=a&client_ids=b) arrive as arrays; take the
  // last so the schema only ever sees a string.
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(req.query)) {
    if (value === undefined || value === '') continue
    raw[key] = Array.isArray(value) ? value[value.length - 1] : value
  }

  const result = querySchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    res.status(400).json({
      status:  'error',
      message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid query',
    })
    return null
  }
  return result.data
}

function filtersFrom(q: ParsedQuery): TransactionFilters {
  return {
    status:    q.status ?? 'all',
    search:    q.search ?? null,
    clientIds: q.client_ids ? q.client_ids.split(',').map((s) => s.trim()).filter(Boolean) : null,
    dateBasis: (q.date_basis ?? 'scheduled') as DateBasis,
    dateFrom:  q.date_from ?? null,
    dateTo:    q.date_to   ?? null,
  }
}

export const list = async (req: Request, res: Response) => {
  const q = parseQuery(req, res)
  if (!q) return
  try {
    const result = await listTransactionsService({
      ...filtersFrom(q),
      page:  q.page  ?? 1,
      limit: q.limit ?? 20,
      sort:  (q.sort ?? 'date_desc') as SortKey,
    })
    res.status(200).json({ status: 'success', data: result.data, meta: result.meta })
  } catch (error: any) {
    console.error('TRANSACTION HISTORY LIST ERROR:', error)
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const summary = async (req: Request, res: Response) => {
  const q = parseQuery(req, res)
  if (!q) return
  try {
    const data = await getTransactionSummaryService(filtersFrom(q))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    console.error('TRANSACTION HISTORY SUMMARY ERROR:', error)
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const companies = async (_req: Request, res: Response) => {
  try {
    const data = await listTransactionCompaniesService()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    console.error('TRANSACTION HISTORY COMPANIES ERROR:', error)
    res.status(500).json({ status: 'error', message: error.message })
  }
}

/**
 * Flat rows as JSON, not a CSV body: the frontend's Next proxy re-serialises
 * every response with NextResponse.json, so a text/csv payload would arrive
 * quoted and broken. The browser turns these into the file.
 */
export const exportRows = async (req: Request, res: Response) => {
  const q = parseQuery(req, res)
  if (!q) return
  try {
    const { rows, truncated } = await exportTransactionsService(filtersFrom(q))
    res.status(200).json({ status: 'success', data: rows, meta: { truncated, count: rows.length } })
  } catch (error: any) {
    console.error('TRANSACTION HISTORY EXPORT ERROR:', error)
    res.status(500).json({ status: 'error', message: error.message })
  }
}
