import { Request, Response } from 'express'
import * as BillingService from '../../services/billing/billing.service.js'
import { BillingError } from '../../services/billing/billing.service.js'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import type { BillingStatus } from '../../types/billing.types.js'

/**
 * HTTP layer for reverse billing: request shape in, `{ status, data }` out.
 * Every rule lives in the service; this only translates.
 */

/** Who is calling, as the service understands it. */
function viewerFrom(req: Request): BillingService.Viewer {
  const { userId } = getRequestMeta(req)
  return {
    userId,
    role: req.user?.role ?? 'client',
    // Set by the client-scoping middleware for client-role callers.
    clientId: req.clientId ?? null,
  }
}

/**
 * A BillingError carries its own status; anything else is a genuine fault and
 * must not leak its message to the caller.
 */
function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof BillingError) {
    res.status(err.status).json({ status: 'error', message: err.message })
    return
  }
  console.error(`[billing:${context}]`, err)
  res.status(500).json({ status: 'error', message: 'Something went wrong handling this billing request.' })
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listPeriods(req: Request, res: Response): Promise<void> {
  try {
    const q = req.query as Record<string, string | undefined>
    const { rows, total } = await BillingService.listPeriods(
      {
        clientId: q.client_id,
        mode: q.mode as 'weekly' | 'monthly' | undefined,
        status: q.status ? (q.status.split(',') as BillingStatus[]) : undefined,
        from: q.from,
        to: q.to,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      },
      viewerFrom(req),
    )
    res.status(200).json({ status: 'success', data: rows, meta: { total } })
  } catch (err) {
    fail(res, err, 'listPeriods')
  }
}

export async function getPeriod(req: Request, res: Response): Promise<void> {
  try {
    const data = await BillingService.getPeriod(param(req.params.periodId), viewerFrom(req))
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'getPeriod')
  }
}

export async function getConsolidation(req: Request, res: Response): Promise<void> {
  try {
    const data = await BillingService.getConsolidation(param(req.params.periodId))
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'getConsolidation')
  }
}

// ---------------------------------------------------------------------------
// Company actions
// ---------------------------------------------------------------------------

export async function saveConsolidation(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.saveConsolidation(
      param(req.params.periodId),
      req.body.items,
      userId,
    )
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'saveConsolidation')
  }
}

export async function sendSummary(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.sendWeeklySummary(param(req.params.periodId), userId)
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'sendSummary')
  }
}

export async function validateSubmission(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.validateSubmission(
      param(req.params.periodId),
      req.body.decision,
      req.body.remarks ?? null,
      userId,
    )
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'validateSubmission')
  }
}

/** Issues one Service Invoice per booking on the period, in a single batch. */
export async function issueInvoices(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.issueServiceInvoices(
      param(req.params.periodId),
      req.body,
      userId,
    )
    res.status(201).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'issueInvoices')
  }
}

export async function recordPayment(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.recordPayment(param(req.params.invoiceId), req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'recordPayment')
  }
}

/** Payments a client has claimed but nobody has verified yet. */
export async function listPendingPayments(req: Request, res: Response): Promise<void> {
  try {
    const periodId = typeof req.query.period_id === 'string' ? req.query.period_id : undefined
    const data = await BillingService.listPendingPayments(periodId)
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'listPendingPayments')
  }
}

export async function verifyPayment(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.verifyPayment(param(req.params.paymentId), req.body, userId)
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'verifyPayment')
  }
}

export async function issueReceipt(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.issueReceipt(param(req.params.paymentId), req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'issueReceipt')
  }
}

// ---------------------------------------------------------------------------
// Client actions
// ---------------------------------------------------------------------------

export async function submitBilling(req: Request, res: Response): Promise<void> {
  try {
    const data = await BillingService.clientSubmitBilling(
      param(req.params.periodId),
      req.body,
      viewerFrom(req),
    )
    res.status(201).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'submitBilling')
  }
}

export async function reviewSummary(req: Request, res: Response): Promise<void> {
  try {
    const data = await BillingService.clientReviewSummary(
      param(req.params.periodId),
      req.body.decision,
      req.body.remarks ?? null,
      viewerFrom(req),
    )
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'reviewSummary')
  }
}

/** The client says they have paid, and attaches evidence. */
export async function submitPaymentProof(req: Request, res: Response): Promise<void> {
  try {
    const data = await BillingService.submitPaymentProof(
      param(req.params.invoiceId),
      req.body,
      viewerFrom(req),
    )
    res.status(201).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'submitPaymentProof')
  }
}

export async function getInvoice(req: Request, res: Response): Promise<void> {
  try {
    const data = await BillingService.getInvoice(param(req.params.invoiceId), viewerFrom(req))
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'getInvoice')
  }
}

/** Fills in a PDF that failed to render at issuance. */
export async function regenerateInvoicePdf(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const data = await BillingService.regenerateInvoicePdf(param(req.params.invoiceId), userId)
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'regenerateInvoicePdf')
  }
}

/** Both BIR booklets: serial counters and Authority to Print blocks. */
export async function listBooklets(req: Request, res: Response): Promise<void> {
  try {
    const data = await BillingService.listBooklets()
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'listBooklets')
  }
}

/**
 * Update one booklet. A risky serial change comes back with
 * `requires_confirmation` and warnings instead of being applied.
 */
export async function updateBooklet(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = getRequestMeta(req)
    const key = param(req.params.seriesKey)
    if (key !== 'service_invoice' && key !== 'acknowledgement_receipt') {
      res.status(404).json({ status: 'error', message: 'Unknown booklet.' })
      return
    }
    const data = await BillingService.updateBooklet(key, req.body, userId)
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err, 'updateBooklet')
  }
}
