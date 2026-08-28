import * as BillingModel from '../../models/billing/billing.model.js'
import { logEvent } from '../../lib/log-event.js'
import { phDay } from '../../lib/ph-date.js'
import {
  bookingTermDays,
  dueDateFor,
  nextFridayOnOrAfter,
  termEndDate,
  weekday,
} from '../../lib/billing-calendar.js'
import { amountInWords, computeInvoiceTotals } from '../../lib/billing-amounts.js'
import { BillingNotices, notifyBilling, periodLabel } from './billing-notify.service.js'
import {
  advancePeriodStates,
  clientPeriodDeliveries,
  ensurePeriodsForClient,
} from './billing-periods.service.js'
import {
  MONTHLY_AMOUNTS_HIDDEN_UNTIL,
  TERMINAL_BILLING_STATUSES,
  type BillingPeriod,
  type PaymentMethod,
  type SaleType,
} from '../../types/billing.types.js'

/**
 * Reverse billing workflow.
 *
 * The two modes are mirror images, and that shapes almost everything here:
 *
 *   weekly   8338 prices the week, SENDS the summary, and the client approves.
 *   monthly  8338 prices the cut-off but keeps it back; the CLIENT sends their
 *            own figures, and 8338 cross-checks them.
 *
 * The monthly direction only works if the client cannot see 8338's numbers
 * before submitting — otherwise the cross-check is theatre. That redaction is
 * enforced here and in the model's projections, never in the UI alone.
 */

/** Who is asking. `clientId` is set only for client-role callers. */
export interface Viewer {
  userId: string | null
  role: string
  clientId?: string | null
}

/**
 * Thrown for rule violations the caller could have avoided. `status` lets the
 * controller map to a code without matching on message text.
 */
export class BillingError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
    this.name = 'BillingError'
  }
}

function assertNotTerminal(period: BillingPeriod): void {
  if (TERMINAL_BILLING_STATUSES.includes(period.status)) {
    throw new BillingError(`This billing period is ${period.status} and can no longer be changed.`, 409)
  }
}

async function loadPeriod(periodId: string) {
  const period = await BillingModel.findPeriodById(periodId)
  if (!period) throw new BillingError('Billing period not found.', 404)
  return period as unknown as BillingPeriod & { clients?: Record<string, unknown> | null }
}

/** A client may only ever touch their own periods. */
function assertOwnership(period: BillingPeriod, viewer: Viewer): void {
  if (viewer.role !== 'client') return
  if (!viewer.clientId || period.client_id !== viewer.clientId) {
    throw new BillingError('Billing period not found.', 404)
  }
}

/**
 * True when this viewer must not see 8338's consolidated figures yet.
 *
 * Only ever true for a monthly period, viewed by the client, before they have
 * submitted. Weekly is the opposite case by design — 8338 sends the summary
 * first, so the client is meant to see it.
 */
export function mustHideAmounts(period: BillingPeriod, viewer: Viewer): boolean {
  return (
    viewer.role === 'client' &&
    period.mode === 'monthly' &&
    MONTHLY_AMOUNTS_HIDDEN_UNTIL.includes(period.status)
  )
}

/**
 * Strip every peso figure from a period a monthly client may not see yet.
 *
 * `deliveries` survives because it is redacted at source — the client still
 * needs to see WHICH deliveries the cut-off covers in order to bill for them,
 * just not what 8338 priced them at.
 */
function redact<T extends Record<string, unknown>>(period: T): T {
  return {
    ...period,
    total_amount: null,
    items: undefined,
    invoices: undefined,
    amounts_hidden: true,
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listPeriods(
  filters: BillingModel.PeriodFilters,
  viewer: Viewer,
) {
  // A client's list is pinned to their own client_id regardless of what the
  // query string asked for.
  const scoped =
    viewer.role === 'client'
      ? { ...filters, clientId: viewer.clientId ?? '__none__' }
      : filters

  // Opening the screen generates any periods the client's completed work has
  // earned and moves them to whatever today's date allows. Without this a newly
  // completed delivery would be invisible until the scheduler's next tick, and
  // the screen would be empty on a fresh deployment.
  if (viewer.role === 'client' && viewer.clientId) {
    const client = await BillingModel.findClientById(viewer.clientId)
    if (client?.billing_mode) {
      await ensurePeriodsForClient(viewer.clientId, client.billing_mode)
      await advancePeriodStates(viewer.clientId)
    }
  }

  const { rows, total } = await BillingModel.findPeriods(scoped)

  // How much completed work each period covers. Both screens lead with this and
  // hide periods holding nothing, so it is counted for staff listings too, not
  // only when the query happens to be scoped to one client.
  const counts = await BillingModel.countDeliveriesByPeriod(scoped.clientId)

  const visible = rows.map((row) => {
    const period = row as unknown as BillingPeriod
    const withCount = {
      ...(row as Record<string, unknown>),
      delivery_count: counts.get(period.period_id) ?? 0,
    }
    return mustHideAmounts(period, viewer) ? redact(withCount) : withCount
  })

  return { rows: visible, total }
}

export async function getPeriod(periodId: string, viewer: Viewer) {
  const period = await loadPeriod(periodId)
  assertOwnership(period, viewer)

  const hidden = mustHideAmounts(period, viewer)

  // A period holds one invoice per booking, so this is a list.
  const [items, submissions, invoices, deliveries] = await Promise.all([
    BillingModel.findPeriodItems(periodId),
    BillingModel.findSubmissions(periodId),
    BillingModel.findInvoicesByPeriod(periodId),
    // The completed deliveries this period covers. The client's screen is built
    // on these, so it always reflects real work rather than the period total.
    clientPeriodDeliveries(period, hidden),
  ])

  const full = { ...period, items, submissions, invoices, deliveries }
  return hidden ? redact(full) : full
}

/**
 * The consolidation worksheet: every completed booking in the period's range,
 * with whatever price has already been put on it.
 */
export async function getConsolidation(periodId: string) {
  const period = await loadPeriod(periodId)
  const [bookings, items] = await Promise.all([
    BillingModel.findBillableBookings(
      period.client_id,
      period.period_start,
      period.period_end,
      periodId,
    ),
    BillingModel.findPeriodItems(periodId),
  ])
  return { period, bookings, items }
}

// ---------------------------------------------------------------------------
// Consolidation (both modes)
// ---------------------------------------------------------------------------

export async function saveConsolidation(
  periodId: string,
  items: BillingModel.PeriodItemInput[],
  actorId: string | null,
) {
  const period = await loadPeriod(periodId)
  assertNotTerminal(period)

  if (!['draft', 'consolidating', 'rejected'].includes(period.status)) {
    throw new BillingError(
      `Consolidation is closed once a period reaches ${period.status}.`,
      409,
    )
  }
  if (!items.length) {
    throw new BillingError('A consolidation needs at least one line item.', 400)
  }

  const { total, count } = await BillingModel.replacePeriodItems(periodId, items)

  const updated = await BillingModel.updatePeriod(periodId, {
    status: 'consolidating',
    consolidation_opened_at: period.consolidation_opened_at ?? new Date().toISOString(),
    // A fresh consolidation clears a previous rejection.
    rejected_by: null,
  })

  logEvent({
    user_id: actorId,
    log_type: 'billing_activity',
    action: 'billing_consolidated',
    description: `Consolidated ${count} line(s) totalling ${total} for period ${periodId} (${periodLabel(period)})`,
  })

  return { period: updated, total, count }
}

// ---------------------------------------------------------------------------
// Weekly: 8338 sends, the client cross-checks
// ---------------------------------------------------------------------------

export async function sendWeeklySummary(periodId: string, actorId: string | null) {
  const period = await loadPeriod(periodId)
  assertNotTerminal(period)

  if (period.mode !== 'weekly') {
    throw new BillingError('Only weekly periods send a summary to the client. Monthly cut-offs wait for the client to submit.', 400)
  }
  if (period.total_amount <= 0) {
    throw new BillingError('Consolidate and price the week before sending the summary.', 400)
  }

  const moved = await BillingModel.transitionPeriod(
    periodId,
    ['consolidating', 'rejected'],
    'awaiting_client_approval',
    {
      summary_sent_at: new Date().toISOString(),
      review_due_on: period.review_due_on,
      rejected_by: null,
    },
  )
  if (!moved) throw new BillingError('This summary has already been sent.', 409)

  // The summary itself is a review round, recorded so revisions are traceable.
  await BillingModel.createSubmission({
    period_id: periodId,
    origin: 'company',
    submitted_by: actorId,
  })

  await notifyBilling(BillingNotices.summarySent(moved), moved)

  logEvent({
    user_id: actorId,
    log_type: 'billing_activity',
    action: 'billing_summary_sent',
    description: `Weekly billing summary for ${periodLabel(moved)} sent to the client`,
  })

  return moved
}

/**
 * The client's verdict on a weekly summary.
 *
 * A rejection returns the period to consolidating so 8338 can revise and
 * resend; nothing is auto-approved when the 3-day window lapses, per the
 * contract — 8338 simply follows up.
 */
export async function clientReviewSummary(
  periodId: string,
  decision: 'approve' | 'reject',
  remarks: string | null,
  viewer: Viewer,
) {
  const period = await loadPeriod(periodId)
  assertOwnership(period, viewer)
  assertNotTerminal(period)

  if (period.mode !== 'weekly') {
    throw new BillingError('Monthly cut-offs are submitted by the client, not approved.', 400)
  }
  if (decision === 'reject' && !remarks?.trim()) {
    throw new BillingError('Tell 8338 what is wrong with the summary so it can be corrected.', 400)
  }

  const latest = await BillingModel.latestSubmission(periodId)
  if (!latest || latest.review_status !== 'pending') {
    throw new BillingError('There is no billing summary awaiting your review.', 409)
  }

  const approved = decision === 'approve'
  const moved = await BillingModel.transitionPeriod(
    periodId,
    ['awaiting_client_approval'],
    approved ? 'approved' : 'rejected',
    approved
      ? { validated_at: new Date().toISOString() }
      : { rejected_by: 'client' },
  )
  if (!moved) throw new BillingError('This summary is no longer awaiting review.', 409)

  await BillingModel.reviewSubmission(latest.submission_id, {
    review_status: approved ? 'accepted' : 'rejected',
    review_remarks: remarks,
    reviewed_by: viewer.userId,
  })

  await notifyBilling(
    approved ? BillingNotices.summaryApproved(moved) : BillingNotices.summaryRejected(moved, remarks),
    moved,
  )

  logEvent({
    user_id: viewer.userId,
    log_type: 'billing_activity',
    action: approved ? 'billing_summary_approved' : 'billing_summary_rejected',
    description: `Client ${approved ? 'approved' : 'rejected'} the weekly summary for ${periodLabel(moved)}`,
  })

  return moved
}

// ---------------------------------------------------------------------------
// Monthly: the client submits, 8338 cross-checks
// ---------------------------------------------------------------------------

export async function clientSubmitBilling(
  periodId: string,
  payload: {
    submitted_amount: number
    client_billing_number?: string | null
    client_billing_date?: string | null
    remarks?: string | null
    document_urls?: string[]
  },
  viewer: Viewer,
) {
  const period = await loadPeriod(periodId)
  assertOwnership(period, viewer)
  assertNotTerminal(period)

  if (period.mode !== 'monthly') {
    throw new BillingError('Weekly billing is sent to you by 8338 for approval, not submitted.', 400)
  }
  if (!['awaiting_submission', 'rejected'].includes(period.status)) {
    throw new BillingError(
      period.status === 'consolidating' || period.status === 'draft'
        ? 'This cut-off is not open for submission yet.'
        : 'This cut-off has already been submitted.',
      409,
    )
  }
  if (!payload.document_urls?.length) {
    throw new BillingError('Attach your billing summary document.', 400)
  }

  const submission = await BillingModel.createSubmission({
    period_id: periodId,
    origin: 'client',
    submitted_amount: payload.submitted_amount,
    client_billing_number: payload.client_billing_number ?? null,
    client_billing_date: payload.client_billing_date ?? null,
    remarks: payload.remarks ?? null,
    document_urls: payload.document_urls,
    submitted_by: viewer.userId,
  })

  const moved = await BillingModel.transitionPeriod(
    periodId,
    ['awaiting_submission', 'rejected'],
    'under_review',
    { submitted_at: new Date().toISOString(), rejected_by: null },
  )
  if (!moved) throw new BillingError('This cut-off is no longer open for submission.', 409)

  await notifyBilling(BillingNotices.submitted(moved, payload.submitted_amount), moved, {
    submission_id: submission.submission_id,
  })

  logEvent({
    user_id: viewer.userId,
    log_type: 'billing_activity',
    action: 'reverse_billing_submitted',
    description: `Client submitted reverse billing r${submission.revision} for ${periodLabel(moved)} (${payload.submitted_amount})`,
  })

  return { period: moved, submission }
}

/**
 * 8338's cross-check of a submitted reverse billing.
 *
 * A rejection sends the period back to awaiting_submission so the client can
 * file a further revision; the loop runs until the figures agree.
 */
export async function validateSubmission(
  periodId: string,
  decision: 'accept' | 'reject',
  remarks: string | null,
  actorId: string | null,
) {
  const period = await loadPeriod(periodId)
  assertNotTerminal(period)

  if (period.mode !== 'monthly') {
    throw new BillingError('Weekly summaries are approved by the client, not validated by 8338.', 400)
  }
  if (period.status !== 'under_review') {
    throw new BillingError('There is no submitted reverse billing to validate.', 409)
  }
  if (decision === 'reject' && !remarks?.trim()) {
    throw new BillingError('Explain the discrepancy so the client can correct their submission.', 400)
  }

  const latest = await BillingModel.latestSubmission(periodId)
  if (!latest) throw new BillingError('There is no submission on this period.', 409)

  const accepted = decision === 'accept'
  const moved = await BillingModel.transitionPeriod(
    periodId,
    ['under_review'],
    accepted ? 'approved' : 'rejected',
    accepted
      ? { validated_at: new Date().toISOString(), validated_by: actorId }
      : { rejected_by: 'company' },
  )
  if (!moved) throw new BillingError('This submission is no longer under review.', 409)

  await BillingModel.reviewSubmission(latest.submission_id, {
    review_status: accepted ? 'accepted' : 'rejected',
    review_remarks: remarks,
    reviewed_by: actorId,
  })

  await notifyBilling(
    accepted ? BillingNotices.submissionAccepted(moved) : BillingNotices.submissionRejected(moved, remarks),
    moved,
  )

  logEvent({
    user_id: actorId,
    log_type: 'billing_activity',
    action: accepted ? 'reverse_billing_validated' : 'reverse_billing_rejected',
    description: `8338 ${accepted ? 'validated' : 'rejected'} the reverse billing for ${periodLabel(moved)}`,
  })

  return moved
}

// ---------------------------------------------------------------------------
// Service Invoice
// ---------------------------------------------------------------------------

export interface IssueInvoiceInput {
  /**
   * Per-booking overrides, keyed by booking_id. Anything omitted takes the
   * defaults below. Lets the accountant set a different withholding rate or
   * booklet serial on one delivery without unpicking the batch.
   */
  overrides?: Record<
    string,
    {
      si_number?: string
      payment_terms_days?: 30 | 45 | 60
      discount_rate?: number
      withholding_tax_rate?: number
      zero_rated_sales?: number
      vat_exempt_sales?: number
    }
  >
  invoice_date?: string
  sale_type?: SaleType
  discount_rate?: number
  withholding_tax_rate?: number
  /** Issue for these bookings only. Omit to invoice every booking on the period. */
  booking_ids?: string[]
}

/**
 * Issue the period's Service Invoices — one per booking.
 *
 * A cut-off is agreed as a whole but billed per delivery, so this fans out:
 * each booking's charge lines become one invoice, carrying that booking's own
 * 30/45/60 term and therefore its own due date. Two invoices from the same
 * cut-off can legitimately fall due on different Fridays.
 *
 * Serials auto-increment from document_series but may be overridden per
 * booking: the BIR-registered booklet is the authority, and the counter is
 * pulled forward to match whatever was actually written.
 *
 * Issuing is resumable. Bookings that already have an invoice are skipped
 * rather than treated as an error, so a batch interrupted halfway can simply be
 * run again.
 */
export async function issueServiceInvoices(
  periodId: string,
  input: IssueInvoiceInput,
  actorId: string | null,
) {
  const period = await loadPeriod(periodId)
  assertNotTerminal(period)

  if (!['approved', 'invoiced'].includes(period.status)) {
    throw new BillingError(
      'Service Invoices can only be issued once both sides have agreed on the billing.',
      409,
    )
  }

  const items = await BillingModel.findPeriodItems(periodId)
  if (!items.length) throw new BillingError('This period has no line items to invoice.', 400)

  // Group the charge lines by booking; each group becomes one invoice.
  const byBooking = new Map<string, typeof items>()
  for (const item of items) {
    if (!item.booking_id) {
      throw new BillingError(
        `Line "${item.description}" is not attached to a booking. Every charge must belong to a delivery, because each invoice covers one booking.`,
        400,
      )
    }
    const group = byBooking.get(item.booking_id) ?? []
    group.push(item)
    byBooking.set(item.booking_id, group)
  }

  const alreadyInvoiced = new Set(await BillingModel.findInvoicedBookingIds(periodId))
  const requested = input.booking_ids?.length ? new Set(input.booking_ids) : null

  // Terms come off the bookings themselves.
  const bookings = await BillingModel.findBillableBookings(
    period.client_id,
    period.period_start,
    period.period_end,
    periodId,
  )
  const termByBooking = new Map(bookings.map((b) => [b.booking_id, bookingTermDays(b.payment_terms)]))
  const refByBooking = new Map(bookings.map((b) => [b.booking_id, b.reference_number ?? b.booking_id]))

  const client = (period as { clients?: Record<string, unknown> | null }).clients ?? {}
  const soldToName = (client.registered_name as string) || (client.company_name as string) || 'Client'
  const invoiceDate = input.invoice_date ?? phDay()

  const issued: Record<string, unknown>[] = []
  const skipped: string[] = []

  for (const [bookingId, lines] of byBooking) {
    if (alreadyInvoiced.has(bookingId)) {
      skipped.push(bookingId)
      continue
    }
    if (requested && !requested.has(bookingId)) continue

    const o = input.overrides?.[bookingId] ?? {}
    const gross = lines.reduce((sum, l) => sum + Number(l.amount), 0)

    const totals = computeInvoiceTotals({
      grossTotal: gross,
      discountRate: o.discount_rate ?? input.discount_rate,
      withholdingTaxRate: o.withholding_tax_rate ?? input.withholding_tax_rate,
      zeroRatedSales: o.zero_rated_sales,
      vatExemptSales: o.vat_exempt_sales,
    })

    // No reconciliation needed: one booking, one term.
    const termDays = o.payment_terms_days ?? termByBooking.get(bookingId) ?? 30

    let siNumber = o.si_number?.trim()
    if (siNumber) {
      const parsed = Number(siNumber.replace(/\D/g, ''))
      if (Number.isFinite(parsed)) await BillingModel.syncSeries('service_invoice', parsed)
    } else {
      siNumber = (await BillingModel.reserveSerial('service_invoice')).formatted
    }

    const invoice = await BillingModel.createInvoice({
      period_id: periodId,
      booking_id: bookingId,
      si_number: siNumber,
      invoice_date: invoiceDate,
      sale_type: input.sale_type ?? 'charge',
      // Snapshotted: an issued invoice must not shift when the client profile does.
      sold_to_name: soldToName,
      sold_to_tin: (client.tin as string) ?? null,
      sold_to_address: (client.billing_address as string) ?? null,
      ...totals,
      payment_terms_days: termDays,
      term_end_date: termEndDate(invoiceDate, termDays),
      due_date: dueDateFor(invoiceDate, termDays),
      payment_status: 'unpaid',
      issued_by: actorId,
    })
    issued.push(invoice)

    await notifyBilling(
      BillingNotices.invoiceIssued(
        period,
        `${siNumber} (${refByBooking.get(bookingId) ?? 'booking'})`,
        totals.total_amount_due,
        invoice.due_date,
      ),
      period,
      { invoice_id: invoice.invoice_id, booking_id: bookingId },
    )
  }

  if (!issued.length && !skipped.length) {
    throw new BillingError('There are no bookings on this period to invoice.', 400)
  }

  const moved = issued.length
    ? await BillingModel.transitionPeriod(periodId, ['approved'], 'invoiced')
    : null

  logEvent({
    user_id: actorId,
    log_type: 'billing_activity',
    action: 'service_invoices_issued',
    description: `Issued ${issued.length} Service Invoice(s) for ${periodLabel(period)}${skipped.length ? `, skipped ${skipped.length} already invoiced` : ''}`,
  })

  return { period: moved ?? period, issued, skipped_count: skipped.length }
}

// ---------------------------------------------------------------------------
// Payment and Acknowledgement Receipt
// ---------------------------------------------------------------------------

export async function recordPayment(
  invoiceId: string,
  payload: {
    amount_paid: number
    payment_date: string
    method: PaymentMethod
    reference_no?: string | null
    notes?: string | null
  },
  actorId: string | null,
) {
  const invoice = await BillingModel.findInvoiceById(invoiceId)
  if (!invoice) throw new BillingError('Service Invoice not found.', 404)
  if (invoice.payment_status === 'paid') {
    throw new BillingError('This invoice has already been settled.', 409)
  }
  if (invoice.payment_status === 'cancelled') {
    throw new BillingError('This invoice was cancelled.', 409)
  }

  // 8338 only accepts payment on Fridays. Enforced here rather than as a CHECK
  // so a corrected historical entry stays possible via a direct fix.
  if (weekday(payload.payment_date) !== 5) {
    throw new BillingError(
      `8338 only accepts payment on Fridays. ${payload.payment_date} is not a Friday — the next one is ${nextFridayOnOrAfter(payload.payment_date)}.`,
      400,
    )
  }

  const payment = await BillingModel.createPayment({
    invoice_id: invoiceId,
    amount_paid: payload.amount_paid,
    payment_date: payload.payment_date,
    method: payload.method,
    reference_no: payload.reference_no ?? null,
    notes: payload.notes ?? null,
    recorded_by: actorId,
  })

  // Only a full settlement closes the invoice; a part payment leaves it open.
  const paidSoFar = (await BillingModel.findPaymentsByInvoice(invoiceId)).reduce(
    (sum, p) => sum + Number(p.amount_paid),
    0,
  )
  const settled = paidSoFar >= Number(invoice.total_amount_due) - 0.005

  if (settled) {
    await BillingModel.updateInvoice(invoiceId, { payment_status: 'paid' })

    // The period only reaches 'paid' when EVERY invoice on it is settled —
    // a cut-off billed across four deliveries is not paid because one was.
    const progress = await BillingModel.periodInvoiceProgress(invoice.period_id)
    if (progress.total > 0 && progress.settled === progress.total) {
      await BillingModel.transitionPeriod(invoice.period_id, ['invoiced'], 'paid')
    }
  }

  const period = await loadPeriod(invoice.period_id)
  await notifyBilling(BillingNotices.paymentRecorded(period, payload.amount_paid), period)

  logEvent({
    user_id: actorId,
    log_type: 'payment',
    action: 'billing_payment_recorded',
    description: `Payment of ${payload.amount_paid} recorded against ${invoice.si_number} on ${payload.payment_date}${settled ? ' (settled)' : ' (partial)'}`,
  })

  return { payment, settled, paid_so_far: paidSoFar }
}

export async function issueReceipt(
  paymentId: string,
  input: { ar_number?: string; receipt_date?: string; account_no?: string | null; payment_for?: string | null },
  actorId: string | null,
) {
  const payment = await BillingModel.findPaymentById(paymentId)
  if (!payment) throw new BillingError('Payment not found.', 404)

  const existing = await BillingModel.findReceiptByPayment(paymentId)
  if (existing) throw new BillingError('An Acknowledgement Receipt has already been issued for this payment.', 409)

  const invoice = await BillingModel.findInvoiceById(payment.invoice_id)
  if (!invoice) throw new BillingError('Service Invoice not found.', 404)

  const period = await loadPeriod(invoice.period_id)

  let arNumber = input.ar_number?.trim()
  if (arNumber) {
    const parsed = Number(arNumber.replace(/\D/g, ''))
    if (Number.isFinite(parsed)) await BillingModel.syncSeries('acknowledgement_receipt', parsed)
  } else {
    arNumber = (await BillingModel.reserveSerial('acknowledgement_receipt')).formatted
  }

  const receipt = await BillingModel.createReceipt({
    payment_id: paymentId,
    invoice_id: payment.invoice_id,
    ar_number: arNumber,
    receipt_date: input.receipt_date ?? payment.payment_date,
    account_no: input.account_no ?? null,
    received_from_name: invoice.sold_to_name,
    business_address: invoice.sold_to_address,
    tin: invoice.sold_to_tin,
    payment_method: payment.method,
    payment_for: input.payment_for ?? `Service Invoice ${invoice.si_number}`,
    description: `Freight and logistics services, ${periodLabel(period)}`,
    total_paid_amount: payment.amount_paid,
    amount_in_words: amountInWords(Number(payment.amount_paid)),
    issued_by: actorId,
  })

  // The receipt closes the cycle — but only once every invoice on the period
  // has one, since a cut-off is billed across several deliveries.
  const progress = await BillingModel.periodInvoiceProgress(invoice.period_id)
  const closed =
    progress.total > 0 && progress.receipted === progress.total
      ? await BillingModel.transitionPeriod(invoice.period_id, ['paid'], 'closed')
      : null

  await notifyBilling(BillingNotices.receiptIssued(period, arNumber), closed ?? period)

  logEvent({
    user_id: actorId,
    log_type: 'billing_activity',
    action: 'acknowledgement_receipt_issued',
    description: `Acknowledgement Receipt ${arNumber} issued for ${invoice.si_number}, closing ${periodLabel(period)}`,
  })

  return receipt
}

export async function getInvoice(invoiceId: string, viewer: Viewer) {
  const invoice = await BillingModel.findInvoiceById(invoiceId)
  if (!invoice) throw new BillingError('Service Invoice not found.', 404)

  if (viewer.role === 'client') {
    const period = await loadPeriod(invoice.period_id)
    assertOwnership(period, viewer)
  }
  const payments = await BillingModel.findPaymentsByInvoice(invoiceId)
  return { ...invoice, payments }
}
