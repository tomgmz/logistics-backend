/**
 * Reverse billing.
 *
 * Column names mirror the database exactly; dates arrive from PostgREST as
 * `YYYY-MM-DD` strings and timestamps as ISO strings, so both stay `string`
 * here rather than being parsed into Date objects that would only have to be
 * serialised again.
 */

/** Which of the two arrangements a client is on, per their contract. */
export type BillingMode = 'weekly' | 'monthly'

/**
 * The workflow status of a billing period.
 *
 * The two modes share a single vocabulary but travel different branches:
 *
 *   weekly   draft -> consolidating -> awaiting_client_approval -> approved
 *   monthly  draft -> consolidating -> awaiting_submission -> under_review -> approved
 *
 * then both run approved -> invoiced -> paid -> closed. `rejected` returns to
 * the branch it came from for another revision.
 *
 * From `invoiced` onward the period is a rollup, because it holds one Service
 * Invoice per booking rather than one overall:
 *
 *   invoiced  the invoices have been issued
 *   paid      EVERY invoice on the period is settled
 *   closed    EVERY invoice has an Acknowledgement Receipt
 *
 * Individual invoices carry their own PaymentStatus and their own due dates,
 * which can differ within one period when the bookings had different terms.
 */
export type BillingStatus =
  | 'draft'
  | 'consolidating'
  | 'awaiting_submission'
  | 'awaiting_client_approval'
  | 'under_review'
  | 'rejected'
  | 'approved'
  | 'invoiced'
  | 'paid'
  | 'closed'
  | 'cancelled'
  | 'rolled_over'

/** Settlement state of an issued Service Invoice. */
export type PaymentStatus = 'unpaid' | 'due' | 'overdue' | 'paid' | 'cancelled'

export type SubmissionOrigin = 'client' | 'company'
export type ReviewStatus     = 'pending' | 'accepted' | 'rejected'
export type SaleType         = 'cash' | 'charge'
export type PaymentMethod    = 'cash' | 'check'
export type RejectedBy       = 'client' | 'company'

/** Statuses in which a period is finished and must not be acted on further. */
export const TERMINAL_BILLING_STATUSES: readonly BillingStatus[] = [
  'closed',
  'cancelled',
  'rolled_over',
]

/**
 * Statuses in which a monthly client must NOT be shown 8338's consolidated
 * figures. The whole point of monthly reverse billing is that the client
 * submits their own numbers and 8338 cross-checks them; revealing the
 * consolidation first turns the check into a formality.
 *
 * Weekly is the reverse — 8338 sends the summary, so the client sees it always.
 */
export const MONTHLY_AMOUNTS_HIDDEN_UNTIL: readonly BillingStatus[] = [
  'draft',
  'consolidating',
  'awaiting_submission',
]

export interface BillingPeriod {
  period_id: string
  client_id: string
  mode: BillingMode
  period_start: string
  period_end: string
  /** 1 = 1st-15th, 2 = 16th to month end. Null for weekly periods. */
  cutoff_no: 1 | 2 | null

  consolidation_start: string | null
  consolidation_end:   string | null
  submission_start:    string | null
  submission_end:      string | null
  validation_start:    string | null
  validation_end:      string | null

  status: BillingStatus
  rejected_by: RejectedBy | null

  consolidation_opened_at:       string | null
  summary_sent_at:               string | null
  submission_window_notified_at: string | null
  review_due_on:                 string | null
  review_lapsed_notified_at:     string | null
  submitted_at:                  string | null
  validated_at:                  string | null
  validated_by:                  string | null

  rolled_into_period_id: string | null
  total_amount: number

  created_at: string
  updated_at: string
}

/**
 * One printed line of the Service Invoice, and the only place a booking's price
 * is authoritatively recorded. `booking_id` is null on an adjustment line.
 */
export interface BillingPeriodItem {
  item_id: string
  period_id: string
  booking_id: string | null
  description: string
  quantity: number
  unit_price: number
  amount: number
  sort_order: number
  created_at: string
  updated_at: string
}

/**
 * A round of the cross-check, in whichever direction the mode runs.
 *
 * Monthly rows are `origin: 'client'` and carry the client's own figure and
 * attachments. Weekly rows are `origin: 'company'` — 8338's summary — and leave
 * `submitted_amount` null, because the figures are the period's line items.
 */
export interface BillingSubmission {
  submission_id: string
  period_id: string
  revision: number
  origin: SubmissionOrigin

  submitted_amount: number | null
  client_billing_number: string | null
  client_billing_date: string | null
  remarks: string | null
  document_urls: string[]

  submitted_by: string | null
  submitted_at: string

  review_status: ReviewStatus
  review_remarks: string | null
  reviewed_by: string | null
  reviewed_at: string | null
}

/**
 * Mirrors 8338's BIR-registered Service Invoice form.
 *
 * One invoice covers exactly ONE booking. A cut-off is consolidated and
 * cross-checked as a whole, then fans out into an invoice per booking — so
 * `period_id` is shared across an issue batch while `booking_id` is unique.
 * That is also why there is no term to reconcile: the invoice carries the term
 * chosen on its own booking.
 */
export interface ServiceInvoice {
  invoice_id: string
  /** The cut-off or week this invoice was consolidated under. Not unique. */
  period_id: string
  /** The single booking billed. Unique across all invoices. */
  booking_id: string | null

  si_number: string
  invoice_date: string
  sale_type: SaleType

  sold_to_name: string
  sold_to_tin: string | null
  sold_to_address: string | null

  vatable_sales: number
  vat_amount: number
  zero_rated_sales: number
  vat_exempt_sales: number

  total_sales_vat_inclusive: number
  net_of_vat: number
  discount_rate: number
  discount_amount: number
  withholding_tax_rate: number
  withholding_tax_amount: number
  total_amount_due: number

  payment_terms_days: 30 | 45 | 60
  /** Raw expiry of the term, before the Friday rule is applied. */
  term_end_date: string
  /** The first Friday on or after `term_end_date` — when payment is accepted. */
  due_date: string

  payment_status: PaymentStatus
  overdue_notified_at: string | null

  pdf_url: string | null
  issued_by: string | null
  issued_at: string

  created_at: string
  updated_at: string
}

export interface BillingPayment {
  payment_id: string
  invoice_id: string
  amount_paid: number
  payment_date: string
  method: PaymentMethod
  reference_no: string | null
  notes: string | null
  recorded_by: string | null
  recorded_at: string
}

/** Mirrors 8338's BIR-registered Acknowledgement Receipt form. */
export interface AcknowledgementReceipt {
  ar_id: string
  payment_id: string
  invoice_id: string

  ar_number: string
  receipt_date: string
  account_no: string | null

  received_from_name: string
  business_address: string | null
  tin: string | null

  payment_method: PaymentMethod
  payment_for: string | null
  description: string | null
  total_paid_amount: number
  amount_in_words: string | null

  pdf_url: string | null
  issued_by: string | null
  issued_at: string

  created_at: string
}

export type DocumentSeriesKey = 'service_invoice' | 'acknowledgement_receipt'

/**
 * Next serial for a BIR booklet. The physical pad is the authority; this only
 * saves the accountant typing and flags a serial that falls outside the pad in
 * use.
 */
export interface DocumentSeries {
  series_key: DocumentSeriesKey
  next_number: number
  booklet_start: number | null
  booklet_end: number | null
  pad_width: number
  updated_at: string
}

/** A period with everything the detail screens and the PDF renderers need. */
export interface BillingPeriodWithRelations extends BillingPeriod {
  client?: {
    client_id: string
    company_name: string | null
    registered_name: string | null
    billing_address: string | null
    tin: string | null
    billing_mode: BillingMode | null
  } | null
  items?: BillingPeriodItem[]
  submissions?: BillingSubmission[]
  invoice?: ServiceInvoice | null
}

/**
 * A completed booking eligible for consolidation, before a price is put on it.
 * Assembled by the model from bookings + destinations, not a table.
 */
export interface BillableBooking {
  booking_id: string
  reference_number: string | null
  schedule_date: string
  origin: string | null
  destinations: string[]
  truck_type_needed: string | null
  payment_terms: string | null
  /** Set once the booking has been priced into a period. */
  billed_amount: number | null
}
