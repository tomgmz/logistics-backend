import * as BillingModel from '../../models/billing/billing.model.js'
import { pool } from '../../lib/database.js'
import { phDay } from '../../lib/ph-date.js'
import {
  buildMonthlyCutoffs,
  buildWeeklyPeriods,
  type Day,
  type HolidayPredicate,
} from '../../lib/billing-calendar.js'
import { BillingNotices, notifyBilling } from './billing-notify.service.js'
import type { BillingMode, BillingPeriod } from '../../types/billing.types.js'

/**
 * Generating billing periods and moving them along by date.
 *
 * Periods are materialised rather than computed on read, because a period
 * accumulates state — what was consolidated, what the client submitted, which
 * invoices came out of it — and because it must keep the schedule it was issued
 * under even if the rules later change.
 *
 * Both entry points here are idempotent and safe to call repeatedly: the
 * scheduler calls them on a timer, and the client's own screen calls them on
 * open so a newly completed delivery shows up without waiting for a tick.
 */

/** Months to look back when a client has never been billed. */
const MAX_BACKFILL_MONTHS = 12

function monthKey(day: Day): { year: number; month: number } {
  const [y, m] = day.split('-').map(Number)
  return { year: y, month: m }
}

/** Every (year, month) from `from` to `to` inclusive, capped. */
function monthsBetween(from: Day, to: Day): { year: number; month: number }[] {
  const start = monthKey(from)
  const end = monthKey(to)
  const out: { year: number; month: number }[] = []
  let { year, month } = start
  while ((year < end.year || (year === end.year && month <= end.month)) && out.length < MAX_BACKFILL_MONTHS) {
    out.push({ year, month })
    month++
    if (month > 12) { month = 1; year++ }
  }
  return out
}

async function holidayPredicate(from: Day, to: Day): Promise<HolidayPredicate> {
  const days = new Set(await BillingModel.findHolidays(from, to))
  return (d: Day) => days.has(d)
}

/**
 * Make sure a client has a billing period for every month in which they have
 * completed work, up to today.
 *
 * Driven off `bookings.schedule_date` — the service date — because the contract
 * bills operating days, so a job scheduled on the Saturday belongs to that
 * Saturday's week even if the paperwork closed later.
 */
export async function ensurePeriodsForClient(
  clientId: string,
  mode: BillingMode,
  today: Day = phDay(),
): Promise<number> {
  // The window worth generating: from the client's earliest unbilled completed
  // booking to today. A client with nothing completed needs no periods at all.
  const { rows } = await pool.query(
    `select to_char(min(b.schedule_date), 'YYYY-MM-DD') as earliest,
            to_char(max(b.schedule_date), 'YYYY-MM-DD') as latest
       from bookings b
       left join billing_booking_claims c on c.booking_id = b.booking_id
      where b.client_id = $1 and b.status = 'completed' and c.booking_id is null`,
    [clientId],
  )
  const earliest: string | null = rows[0]?.earliest ?? null
  if (!earliest) return 0

  // A booking scheduled in the future still gets a period, so the client can see
  // it queued rather than have it silently vanish until the month turns.
  const latest: string = rows[0].latest > today ? rows[0].latest : today

  let created = 0
  for (const { year, month } of monthsBetween(earliest, latest)) {
    if (mode === 'weekly') {
      const isHoliday = await holidayPredicate(`${year}-01-01`, `${year + 1}-01-01`)
      for (const w of buildWeeklyPeriods(year, month, isHoliday)) {
        const row = await BillingModel.ensurePeriod({
          client_id: clientId,
          mode: 'weekly',
          period_start: w.periodStart,
          period_end: w.periodEnd,
          cutoff_no: null,
          // 8338 prepares the billing on the first working day after the week.
          consolidation_start: w.summarySendDay,
          consolidation_end: w.summarySendDay,
          submission_start: w.reviewWindow.start,
          submission_end: w.reviewWindow.end,
          validation_start: w.reviewWindow.start,
          validation_end: w.reviewWindow.end,
          review_due_on: w.reviewWindow.end,
        })
        if (row) created++
      }
    } else {
      for (const c of buildMonthlyCutoffs(year, month)) {
        const row = await BillingModel.ensurePeriod({
          client_id: clientId,
          mode: 'monthly',
          period_start: c.periodStart,
          period_end: c.periodEnd,
          cutoff_no: c.cutoffNo,
          consolidation_start: c.consolidationWindow.start,
          consolidation_end: c.consolidationWindow.end,
          submission_start: c.submissionWindow.start,
          submission_end: c.submissionWindow.end,
          validation_start: c.validationWindow.start,
          validation_end: c.validationWindow.end,
        })
        if (row) created++
      }
    }
  }
  return created
}

/**
 * Move a client's periods along to whatever today's date entitles them to.
 *
 * Only date-driven transitions happen here. Anything that needs a person —
 * 8338 sending a weekly summary, the client submitting, either side accepting —
 * stays where it is until somebody acts.
 *
 * The monthly submission window opens whether or not 8338 has consolidated yet.
 * That is deliberate: in a reverse arrangement the client's figures are their
 * own, and 8338's consolidation exists to check them against, not to gate them.
 */
export async function advancePeriodStates(clientId: string, today: Day = phDay()): Promise<void> {
  const { rows } = await BillingModel.findPeriods({ clientId, limit: 100 })

  for (const raw of rows) {
    const p = raw as unknown as BillingPeriod

    // A period cannot be worked until the work it covers is over.
    if (p.period_end >= today) continue

    if (p.status === 'draft') {
      const opensOn = p.consolidation_start ?? p.period_end
      if (today >= opensOn) {
        await BillingModel.transitionPeriod(p.period_id, ['draft'], 'consolidating', {
          consolidation_opened_at: new Date().toISOString(),
        })
      }
    }

    // Monthly only. Weekly waits for 8338 to send the summary, which is a
    // person's action, not a date's.
    if (p.mode === 'monthly' && p.submission_start && today >= p.submission_start) {
      const opened = await BillingModel.transitionPeriod(
        p.period_id,
        ['draft', 'consolidating'],
        'awaiting_submission',
        { submission_window_notified_at: new Date().toISOString() },
      )
      if (opened) await notifyBilling(BillingNotices.submissionWindowOpen(opened), opened)
    }
  }
}

/**
 * Everything a client needs to see on their reverse billing screen, for one
 * period: the deliveries it covers and — only when they are entitled to it —
 * what 8338 priced them at.
 *
 * A monthly client is shown the SCOPE of the cut-off (which deliveries, how
 * many) but never the amounts until they have submitted their own figures.
 * Agreeing on what is being billed is not the same as being handed the answer,
 * and the cross-check only means something if the two sides arrive at their
 * totals independently. Weekly is the opposite: 8338 sends the summary first,
 * so the amounts are the whole point.
 */
export async function clientPeriodDeliveries(
  period: BillingPeriod,
  amountsHidden: boolean,
) {
  const bookings = await BillingModel.findBillableBookings(
    period.client_id,
    period.period_start,
    period.period_end,
    period.period_id,
  )

  return bookings.map((b) => ({
    booking_id: b.booking_id,
    reference_number: b.reference_number,
    schedule_date: b.schedule_date,
    origin: b.origin,
    destinations: b.destinations,
    truck_type_needed: b.truck_type_needed,
    payment_terms: b.payment_terms,
    // Withheld rather than omitted, so the UI can say "not disclosed yet"
    // instead of rendering a blank where a number belongs.
    billed_amount: amountsHidden ? null : b.billed_amount,
  }))
}
