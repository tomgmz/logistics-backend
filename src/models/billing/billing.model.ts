import { supabase } from '../../lib/supabase.js'
import { pool } from '../../lib/database.js'
import type {
  BillableBooking,
  BillingMode,
  BillingPeriod,
  BillingStatus,
  DocumentSeriesKey,
  PaymentStatus,
  RejectedBy,
  SubmissionOrigin,
} from '../../types/billing.types.js'

/**
 * Data access for reverse billing.
 *
 * Two clients are in play, matching the rest of the codebase: `supabase` for
 * ordinary row reads and writes, and the raw `pool` where a statement needs a
 * join, an aggregate, or a transaction that PostgREST cannot express.
 */

const PERIOD_SELECT = `
  period_id, client_id, mode, period_start, period_end, cutoff_no,
  consolidation_start, consolidation_end, submission_start, submission_end,
  validation_start, validation_end,
  status, rejected_by,
  consolidation_opened_at, summary_sent_at, submission_window_notified_at,
  review_due_on, review_lapsed_notified_at, submitted_at, validated_at, validated_by,
  rolled_into_period_id, total_amount, created_at, updated_at
`

const CLIENT_SELECT = `
  clients (
    client_id, company_name, registered_name, billing_address, tin, billing_mode
  )
`

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export async function findPeriodById(periodId: string) {
  const { data, error } = await supabase
    .from('billing_periods')
    .select(`${PERIOD_SELECT}, ${CLIENT_SELECT}`)
    .eq('period_id', periodId)
    .maybeSingle()

  if (error) throw error
  return data
}

export interface PeriodFilters {
  clientId?: string
  mode?: BillingMode
  status?: BillingStatus | BillingStatus[]
  from?: string
  to?: string
  search?: string
  limit?: number
  offset?: number
}

export async function findPeriods(filters: PeriodFilters) {
  let q = supabase
    .from('billing_periods')
    .select(`${PERIOD_SELECT}, ${CLIENT_SELECT}`, { count: 'exact' })
    .order('period_start', { ascending: false })

  if (filters.clientId) q = q.eq('client_id', filters.clientId)
  if (filters.mode)     q = q.eq('mode', filters.mode)
  if (filters.status) {
    q = Array.isArray(filters.status)
      ? q.in('status', filters.status)
      : q.eq('status', filters.status)
  }
  if (filters.from) q = q.gte('period_start', filters.from)
  if (filters.to)   q = q.lte('period_end', filters.to)

  const limit  = filters.limit  ?? 20
  const offset = filters.offset ?? 0
  q = q.range(offset, offset + limit - 1)

  const { data, error, count } = await q
  if (error) throw error
  return { rows: data ?? [], total: count ?? 0 }
}

/**
 * Create a period if the client does not already have that exact cycle.
 *
 * The scheduler re-runs constantly and must not duplicate periods, so this
 * leans on the (client_id, mode, period_start, period_end) unique constraint
 * and treats a conflict as success rather than racing a SELECT first.
 */
export async function ensurePeriod(row: {
  client_id: string
  mode: BillingMode
  period_start: string
  period_end: string
  cutoff_no: 1 | 2 | null
  consolidation_start?: string | null
  consolidation_end?: string | null
  submission_start?: string | null
  submission_end?: string | null
  validation_start?: string | null
  validation_end?: string | null
  review_due_on?: string | null
}): Promise<BillingPeriod | null> {
  const { data, error } = await supabase
    .from('billing_periods')
    .upsert(row, {
      onConflict: 'client_id,mode,period_start,period_end',
      ignoreDuplicates: true,
    })
    .select(PERIOD_SELECT)
    .maybeSingle()

  if (error) throw error
  return data as BillingPeriod | null
}

export async function updatePeriod(
  periodId: string,
  fields: Partial<{
    status: BillingStatus
    rejected_by: RejectedBy | null
    consolidation_opened_at: string | null
    summary_sent_at: string | null
    submission_window_notified_at: string | null
    review_due_on: string | null
    review_lapsed_notified_at: string | null
    submitted_at: string | null
    validated_at: string | null
    validated_by: string | null
    rolled_into_period_id: string | null
    total_amount: number
  }>,
) {
  const { data, error } = await supabase
    .from('billing_periods')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('period_id', periodId)
    .select(PERIOD_SELECT)
    .single()

  if (error) throw error
  return data
}

/**
 * Move a period's status only if it is currently one of `from`.
 *
 * Every workflow transition goes through here. Without the guard, a double
 * click or a scheduler tick racing a human action can drive a period backwards
 * — re-sending a summary that was already approved, say. A null result means
 * the period had moved on and the caller should report a conflict.
 */
export async function transitionPeriod(
  periodId: string,
  from: BillingStatus[],
  to: BillingStatus,
  extra: Record<string, unknown> = {},
) {
  const { data, error } = await supabase
    .from('billing_periods')
    .update({ status: to, ...extra, updated_at: new Date().toISOString() })
    .eq('period_id', periodId)
    .in('status', from)
    .select(PERIOD_SELECT)
    .maybeSingle()

  if (error) throw error
  return data as BillingPeriod | null
}

/** Periods the scheduler should look at, by status and a date threshold. */
export async function findPeriodsForSweep(status: BillingStatus[], onOrBefore: string) {
  const { data, error } = await supabase
    .from('billing_periods')
    .select(PERIOD_SELECT)
    .in('status', status)
    .lte('period_end', onOrBefore)
    .limit(500)

  if (error) throw error
  return (data ?? []) as BillingPeriod[]
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * Completed bookings in a period's date range that may still be billed.
 *
 * A booking belongs to the period covering its `schedule_date` — the service
 * date, not a completion timestamp — because the contract bills operating days.
 * Bookings claimed by ANOTHER period are excluded via billing_booking_claims;
 * ones claimed by THIS period are included, with the total already priced onto
 * them, so re-opening consolidation shows the work so far.
 */
export async function findBillableBookings(
  clientId: string,
  periodStart: string,
  periodEnd: string,
  periodId: string | null,
): Promise<BillableBooking[]> {
  const { rows } = await pool.query(
    `select b.booking_id,
            b.reference_number,
            to_char(b.schedule_date, 'YYYY-MM-DD') as schedule_date,
            b.origin,
            b.truck_type_needed,
            b.payment_terms,
            coalesce(
              array_agg(distinct d.address) filter (where d.address is not null),
              '{}'
            ) as destinations,
            -- A booking may carry several charge lines; the invoice bills their sum.
            (select sum(i.amount) from billing_period_items i
              where i.booking_id = b.booking_id) as billed_amount
       from bookings b
       left join booking_destinations d on d.booking_id = b.booking_id
       left join billing_booking_claims c on c.booking_id = b.booking_id
      where b.client_id = $1
        and b.status = 'completed'
        and b.schedule_date between $2::date and $3::date
        and (c.booking_id is null or c.period_id = $4::uuid)
      group by b.booking_id
      order by b.schedule_date asc, b.reference_number asc`,
    [clientId, periodStart, periodEnd, periodId],
  )

  return rows.map((r) => ({
    booking_id: r.booking_id,
    reference_number: r.reference_number,
    schedule_date: r.schedule_date,
    origin: r.origin,
    destinations: r.destinations ?? [],
    truck_type_needed: r.truck_type_needed,
    payment_terms: r.payment_terms,
    billed_amount: r.billed_amount === null ? null : Number(r.billed_amount),
  }))
}

export interface PeriodItemInput {
  booking_id: string | null
  description: string
  quantity: number
  unit_price: number
  sort_order?: number
}

/**
 * Replace a period's line items wholesale, in one transaction.
 *
 * Consolidation is an editing session, not an append log: the accountant sets
 * the whole list and saves. Doing it transactionally keeps four things from
 * drifting apart — the items, the booking claims, the period total, and the
 * `bookings.total_cost` mirror the client-facing history screen reads.
 *
 * A booking may hold several charge lines (freight, surcharge, waiting time),
 * which is what the invoice's per-item breakdown prints; `total_cost` and the
 * eventual invoice take their sum.
 */
export async function replacePeriodItems(periodId: string, items: PeriodItemInput[]) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Clear the mirror and the claims on bookings this period previously
    // covered, so ones dropped from the list are released back to the pool.
    await client.query(
      `update bookings set total_cost = null
        where booking_id in (select booking_id from billing_booking_claims where period_id = $1)`,
      [periodId],
    )
    await client.query('delete from billing_booking_claims where period_id = $1', [periodId])
    await client.query('delete from billing_period_items where period_id = $1', [periodId])

    let total = 0
    const perBooking = new Map<string, number>()

    for (const [i, item] of items.entries()) {
      const amount = Number((item.quantity * item.unit_price).toFixed(2))
      total += amount
      await client.query(
        `insert into billing_period_items
           (period_id, booking_id, description, quantity, unit_price, amount, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          periodId,
          item.booking_id,
          item.description,
          item.quantity,
          item.unit_price,
          amount,
          item.sort_order ?? i,
        ],
      )
      if (item.booking_id) {
        perBooking.set(item.booking_id, (perBooking.get(item.booking_id) ?? 0) + amount)
      }
    }

    for (const [bookingId, amount] of perBooking) {
      // Claiming here is what stops another period from consolidating the same
      // booking. The primary key on booking_id makes a double claim impossible
      // rather than merely unlikely.
      await client.query(
        'insert into billing_booking_claims (booking_id, period_id) values ($1, $2)',
        [bookingId, periodId],
      )
      await client.query('update bookings set total_cost = $2 where booking_id = $1', [
        bookingId,
        Number(amount.toFixed(2)),
      ])
    }

    const rounded = Number(total.toFixed(2))
    await client.query(
      'update billing_periods set total_amount = $2, updated_at = now() where period_id = $1',
      [periodId, rounded],
    )

    await client.query('COMMIT')
    return { total: rounded, count: items.length, bookings: perBooking.size }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    // A claim collision means another period already owns one of these bookings.
    if ((err as { code?: string }).code === '23505') {
      throw new Error('One of these bookings is already being billed on another period.')
    }
    throw err
  } finally {
    client.release()
  }
}

export async function findPeriodItems(periodId: string) {
  const { data, error } = await supabase
    .from('billing_period_items')
    .select('*')
    .eq('period_id', periodId)
    .order('sort_order', { ascending: true })

  if (error) throw error
  return data ?? []
}

/**
 * Drop a period's items, releasing its bookings back into the pool.
 *
 * Used when a period is cancelled or rolled over: the unique index on
 * booking_id would otherwise keep those bookings permanently unbillable.
 */
export async function releasePeriodItems(periodId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `update bookings set total_cost = null
        where booking_id in (select booking_id from billing_booking_claims where period_id = $1)`,
      [periodId],
    )
    await client.query('delete from billing_booking_claims where period_id = $1', [periodId])
    await client.query('delete from billing_period_items where period_id = $1', [periodId])
    await client.query(
      'update billing_periods set total_amount = 0, updated_at = now() where period_id = $1',
      [periodId],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Submissions / reviews
// ---------------------------------------------------------------------------

export async function findSubmissions(periodId: string) {
  const { data, error } = await supabase
    .from('billing_submissions')
    .select('*')
    .eq('period_id', periodId)
    .order('revision', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function latestSubmission(periodId: string) {
  const { data, error } = await supabase
    .from('billing_submissions')
    .select('*')
    .eq('period_id', periodId)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function createSubmission(row: {
  period_id: string
  origin: SubmissionOrigin
  submitted_amount?: number | null
  client_billing_number?: string | null
  client_billing_date?: string | null
  remarks?: string | null
  document_urls?: string[]
  submitted_by?: string | null
}) {
  // Revisions are per period and only ever appended, so the next one is simply
  // one past the highest. Two concurrent submissions on the same period would
  // collide on the (period_id, revision) unique constraint, which is the right
  // outcome — the second is a duplicate, not a new round.
  const previous = await latestSubmission(row.period_id)
  const revision = previous ? previous.revision + 1 : 1

  const { data, error } = await supabase
    .from('billing_submissions')
    .insert({ ...row, revision, document_urls: row.document_urls ?? [] })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function reviewSubmission(
  submissionId: string,
  fields: { review_status: 'accepted' | 'rejected'; review_remarks?: string | null; reviewed_by?: string | null },
) {
  const { data, error } = await supabase
    .from('billing_submissions')
    .update({ ...fields, reviewed_at: new Date().toISOString() })
    .eq('submission_id', submissionId)
    .eq('review_status', 'pending')
    .select()
    .maybeSingle()

  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Document serials
// ---------------------------------------------------------------------------

/**
 * Reserve the next serial for a BIR booklet.
 *
 * The increment happens in the same statement that reads the value, so two
 * accountants issuing at once cannot be handed the same number. The physical
 * booklet remains the authority, which is why the caller may override the
 * result — `syncSeries` then pulls the counter back in line.
 */
export async function reserveSerial(key: DocumentSeriesKey): Promise<{ number: number; formatted: string }> {
  const { rows } = await pool.query(
    `update document_series
        set next_number = next_number + 1, updated_at = now()
      where series_key = $1
      returning next_number - 1 as reserved, pad_width, booklet_start, booklet_end`,
    [key],
  )
  if (!rows.length) throw new Error(`Unknown document series: ${key}`)

  const n = Number(rows[0].reserved)
  return { number: n, formatted: String(n).padStart(rows[0].pad_width, '0') }
}

export async function peekSeries(key: DocumentSeriesKey) {
  const { data, error } = await supabase
    .from('document_series')
    .select('*')
    .eq('series_key', key)
    .maybeSingle()

  if (error) throw error
  return data
}

/**
 * Move the counter past a serial the accountant typed in by hand, so the next
 * auto-assigned number follows the booklet rather than repeating what was just
 * used. Never moves the counter backwards.
 */
export async function syncSeries(key: DocumentSeriesKey, usedNumber: number) {
  const { error } = await supabase
    .from('document_series')
    .update({ next_number: usedNumber + 1, updated_at: new Date().toISOString() })
    .eq('series_key', key)
    .lt('next_number', usedNumber + 1)

  if (error) throw error
}

// ---------------------------------------------------------------------------
// Invoices, payments, receipts
// ---------------------------------------------------------------------------

export async function createInvoice(row: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('service_invoices')
    .insert(row)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Every invoice a period issued — one per booking, so this is a list.
 *
 * Ordered by serial so a cut-off's invoices read in the order the booklet was
 * written, which is how the accountant will reconcile against the physical pad.
 */
export async function findInvoicesByPeriod(periodId: string) {
  const { data, error } = await supabase
    .from('service_invoices')
    .select('*')
    .eq('period_id', periodId)
    .order('si_number', { ascending: true })

  if (error) throw error
  return data ?? []
}

/** A booking can be invoiced once; this is that invoice, if it exists. */
export async function findInvoiceByBooking(bookingId: string) {
  const { data, error } = await supabase
    .from('service_invoices')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) throw error
  return data
}

/** Booking ids on this period that already have an invoice. */
export async function findInvoicedBookingIds(periodId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('service_invoices')
    .select('booking_id')
    .eq('period_id', periodId)
    .not('booking_id', 'is', null)

  if (error) throw error
  return (data ?? []).map((r) => r.booking_id as string)
}

export async function findInvoiceById(invoiceId: string) {
  const { data, error } = await supabase
    .from('service_invoices')
    .select(`*, billing_periods ( period_id, client_id, mode, period_start, period_end, status )`)
    .eq('invoice_id', invoiceId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function updateInvoice(invoiceId: string, fields: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('service_invoices')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('invoice_id', invoiceId)
    .select()
    .single()

  if (error) throw error
  return data
}

/** Issued invoices whose settlement state the scheduler may need to advance. */
export async function findInvoicesForAgeing(today: string) {
  const { data, error } = await supabase
    .from('service_invoices')
    .select('invoice_id, period_id, due_date, payment_status')
    .in('payment_status', ['unpaid', 'due'])
    .lte('due_date', today)
    .limit(500)

  if (error) throw error
  return (data ?? []) as { invoice_id: string; period_id: string; due_date: string; payment_status: PaymentStatus }[]
}

/**
 * How far a period has got, now that it holds many invoices.
 *
 * A period is only `paid` once every one of its invoices is settled, and only
 * `closed` once every one has an Acknowledgement Receipt — so the rollup has to
 * be counted rather than inferred from the last action taken.
 */
export async function periodInvoiceProgress(periodId: string): Promise<{
  total: number
  settled: number
  receipted: number
}> {
  const { rows } = await pool.query(
    `select count(*)::int                                             as total,
            count(*) filter (where i.payment_status = 'paid')::int    as settled,
            count(*) filter (where r.ar_id is not null)::int          as receipted
       from service_invoices i
       left join acknowledgement_receipts r on r.invoice_id = i.invoice_id
      where i.period_id = $1`,
    [periodId],
  )
  return rows[0] ?? { total: 0, settled: 0, receipted: 0 }
}

export async function createPayment(row: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('billing_payments')
    .insert(row)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function findPaymentsByInvoice(invoiceId: string) {
  const { data, error } = await supabase
    .from('billing_payments')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('payment_date', { ascending: true })

  if (error) throw error
  return data ?? []
}

export async function findPaymentById(paymentId: string) {
  const { data, error } = await supabase
    .from('billing_payments')
    .select('*')
    .eq('payment_id', paymentId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function createReceipt(row: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('acknowledgement_receipts')
    .insert(row)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function findReceiptByPayment(paymentId: string) {
  const { data, error } = await supabase
    .from('acknowledgement_receipts')
    .select('*')
    .eq('payment_id', paymentId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function updateReceipt(arId: string, fields: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('acknowledgement_receipts')
    .update(fields)
    .eq('ar_id', arId)
    .select()
    .single()

  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Clients and holidays
// ---------------------------------------------------------------------------

/** Active clients with a billing arrangement, for the period generator. */
export async function findBillableClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('client_id, company_name, registered_name, billing_address, tin, billing_mode')
    .not('billing_mode', 'is', null)

  if (error) throw error
  return data ?? []
}

/**
 * How many completed deliveries fall inside each of a client's periods.
 *
 * One query for the whole list rather than one per card: the billing screen
 * leads with "how much work is in this cut-off", and a period with no completed
 * deliveries is noise the client should never be shown.
 */
export async function countDeliveriesByPeriod(clientId: string): Promise<Map<string, number>> {
  const { rows } = await pool.query(
    `select p.period_id, count(b.booking_id)::int as n
       from billing_periods p
       left join bookings b
         on b.client_id = p.client_id
        and b.status = 'completed'
        and b.schedule_date between p.period_start and p.period_end
      where p.client_id = $1
      group by p.period_id`,
    [clientId],
  )
  return new Map(rows.map((r) => [r.period_id as string, Number(r.n)]))
}

export async function findClientById(clientId: string) {
  const { data, error } = await supabase
    .from('clients')
    .select('client_id, company_name, registered_name, billing_address, tin, billing_mode')
    .eq('client_id', clientId)
    .maybeSingle()

  if (error) throw error
  return data as { client_id: string; billing_mode: BillingMode | null } | null
}

export async function findHolidays(from: string, to: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('ph_holidays')
    .select('holiday_date')
    .gte('holiday_date', from)
    .lte('holiday_date', to)

  if (error) throw error
  return (data ?? []).map((r) => r.holiday_date as string)
}
