import { z } from 'zod'

/**
 * Request validation for reverse billing.
 *
 * Money is `number` with two decimals rather than a string: the client sends
 * JSON numbers, and PostgREST writes them into numeric(14,2) columns. The
 * rounding that matters happens in billing-amounts.ts.
 */

const money = z
  .number()
  .finite()
  .nonnegative()
  .refine((n) => Math.round(n * 100) === Number((n * 100).toFixed(0)), {
    message: 'Amount cannot be finer than one centavo',
  })

const PAYMENT_TERMS = z.union([z.literal(30), z.literal(45), z.literal(60)])

/** Cloudinary is the only place files live; the API only ever sees URLs. */
const documentUrls = z
  .array(z.string().url('Each attachment must be an uploaded file URL'))
  .min(1, 'Attach your billing summary document')
  .max(5, 'At most 5 attachments')

export const consolidationItemSchema = z.object({
  // Required: every charge must belong to a delivery, because each Service
  // Invoice covers exactly one booking and the lines are grouped by it. Several
  // lines MAY share a booking — that is the invoice's per-item breakdown
  // (freight, surcharge, waiting time).
  booking_id: z.string().uuid('Every charge line must be attached to a booking'),
  description: z.string().trim().min(1, 'Describe the service').max(200),
  quantity: z.number().positive('Quantity must be greater than zero').default(1),
  unit_price: money,
  sort_order: z.number().int().nonnegative().optional(),
})

export const saveConsolidationSchema = z.object({
  items: z
    .array(consolidationItemSchema)
    .min(1, 'A consolidation needs at least one line item')
    .max(200, 'Too many line items for one period'),
})

export const clientSubmitBillingSchema = z.object({
  submitted_amount: money,
  client_billing_number: z.string().trim().max(60).optional().nullable(),
  client_billing_date: z.string().date().optional().nullable(),
  remarks: z.string().trim().max(1000).optional().nullable(),
  document_urls: documentUrls,
})

export const clientReviewSummarySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    remarks: z.string().trim().max(1000).optional().nullable(),
  })
  // A rejection without a reason gives 8338 nothing to correct, and the cycle
  // just loops.
  .refine((v) => v.decision === 'approve' || !!v.remarks?.trim(), {
    message: 'Tell 8338 what is wrong with the summary',
    path: ['remarks'],
  })

export const validateSubmissionSchema = z
  .object({
    decision: z.enum(['accept', 'reject']),
    remarks: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((v) => v.decision === 'accept' || !!v.remarks?.trim(), {
    message: 'Explain the discrepancy so the client can correct their submission',
    path: ['remarks'],
  })

/** Settings for one booking's invoice, overriding the batch defaults. */
const invoiceOverrideSchema = z.object({
  // Omit to take the next serial from document_series; supply to match the
  // BIR booklet actually being written on.
  si_number: z.string().trim().min(1).max(30).optional(),
  // Normally taken from the booking itself — one invoice, one booking, one term.
  payment_terms_days: PAYMENT_TERMS.optional(),
  discount_rate: z.number().min(0).max(100).optional(),
  withholding_tax_rate: z.number().min(0).max(100).optional(),
  zero_rated_sales: money.optional(),
  vat_exempt_sales: money.optional(),
})

/**
 * Issues the period's invoices as a batch — one per booking. Batch-level values
 * apply to every invoice unless a per-booking override says otherwise.
 */
export const issueInvoiceSchema = z.object({
  invoice_date: z.string().date().optional(),
  sale_type: z.enum(['cash', 'charge']).optional(),
  discount_rate: z.number().min(0).max(100).optional(),
  // Defaults to 0 rather than the common 2% for services: the rate depends on
  // the client's tax status and must be a deliberate entry on a BIR document.
  withholding_tax_rate: z.number().min(0).max(100).optional(),
  // Invoice only these bookings; omit to invoice every booking on the period.
  booking_ids: z.array(z.string().uuid()).optional(),
  overrides: z.record(z.string().uuid(), invoiceOverrideSchema).optional(),
})

/**
 * The client's claim that they have paid, with evidence.
 *
 * `client_declared_date` is deliberately NOT Friday-validated: a bank transfer
 * lands whenever it lands. The Friday rule governs when 8338 accepts payment,
 * which is the accountant's date at verification.
 */
export const submitPaymentProofSchema = z.object({
  amount_paid: money.refine((n) => n > 0, 'Enter the amount you paid'),
  client_declared_date: z.string().date(),
  method: z.enum(['cash', 'check']),
  reference_no: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  proof_urls: z
    .array(z.string().url('Each attachment must be an uploaded file URL'))
    .min(1, 'Attach proof of your payment')
    .max(3, 'At most 3 attachments'),
})

export const verifyPaymentSchema = z
  .object({
    decision: z.enum(['confirm', 'reject']),
    // The Friday 8338 accepted the money. Checked in the service, which can name
    // the next Friday in the error rather than just rejecting the shape.
    payment_date: z.string().date().optional(),
    remarks: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => v.decision !== 'confirm' || !!v.payment_date, {
    message: 'Enter the Friday on which 8338 accepted this payment',
    path: ['payment_date'],
  })
  .refine((v) => v.decision !== 'reject' || !!v.remarks?.trim(), {
    message: 'Tell the client why the payment could not be confirmed',
    path: ['remarks'],
  })

export const recordPaymentSchema = z.object({
  amount_paid: money.refine((n) => n > 0, 'Payment must be greater than zero'),
  // The Friday rule is checked in the service, which can name the next Friday
  // in the error rather than just rejecting the shape.
  payment_date: z.string().date(),
  method: z.enum(['cash', 'check']),
  reference_no: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  // An accountant taking cash at the office may still have a slip to attach.
  proof_urls: z.array(z.string().url()).max(3).optional(),
})

export const issueReceiptSchema = z.object({
  ar_number: z.string().trim().min(1).max(30).optional(),
  receipt_date: z.string().date().optional(),
  account_no: z.string().trim().max(60).optional().nullable(),
  payment_for: z.string().trim().max(200).optional().nullable(),
})

export const listPeriodsQuerySchema = z.object({
  client_id: z.string().uuid().optional(),
  mode: z.enum(['weekly', 'monthly']).optional(),
  status: z.string().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export type SaveConsolidationInput = z.infer<typeof saveConsolidationSchema>
export type ClientSubmitBillingInput = z.infer<typeof clientSubmitBillingSchema>
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>

/**
 * Booklet settings — the serial counter and the Authority to Print block on a
 * BIR pad. Every field is optional so the form can save one change at a time.
 */
export const updateBookletSchema = z.object({
  next_number: z.number().int().positive().max(9_999_999).optional(),
  booklet_start: z.number().int().positive().nullable().optional(),
  booklet_end: z.number().int().positive().nullable().optional(),
  // Zero-padding on the printed serial: the AR pad prints 0015, the SI 151.
  pad_width: z.number().int().min(1).max(10).optional(),

  // Stored and printed verbatim — the point is to reproduce the pad's footer,
  // so the date is text rather than a date, and is never reformatted.
  atp_number: z.string().trim().max(80).nullable().optional(),
  atp_date: z.string().trim().max(40).nullable().optional(),
  booklet_label: z.string().trim().max(80).nullable().optional(),

  printer_name: z.string().trim().max(120).nullable().optional(),
  printer_address: z.string().trim().max(160).nullable().optional(),
  printer_vat: z.string().trim().max(120).nullable().optional(),
  printer_accreditation: z.string().trim().max(120).nullable().optional(),
  printer_issued: z.string().trim().max(60).nullable().optional(),
  printer_expiry: z.string().trim().max(60).nullable().optional(),

  // Re-submitted after the accountant has read the warnings a risky serial
  // change produces. See updateBooklet in the service.
  acknowledge_warnings: z.boolean().optional(),
})
  .refine(
    (v) => v.booklet_start == null || v.booklet_end == null || v.booklet_end >= v.booklet_start,
    { message: 'The end of the range cannot be before its start', path: ['booklet_end'] },
  )
