/**
 * Billing calendar for 8338's two reverse-billing arrangements.
 *
 * Everything here is pure: calendar days in, calendar days out, no database and
 * no clock. Billing dates decide when money is owed, so they must be derivable
 * and testable without standing up the rest of the system.
 *
 * Days are `YYYY-MM-DD` strings and all arithmetic runs in UTC. That is not a
 * timezone claim — it is the standard trick for date-only maths: anchoring to a
 * fixed offset keeps `addDays` from drifting across a DST boundary in whatever
 * zone the server happens to run in. Where a *current* day is needed, callers
 * supply it from `phDay()` in ./ph-date, which is the operation's own calendar.
 *
 * 8338 does not operate on Sundays. Two different notions of "day" follow from
 * that, and they are deliberately not the same:
 *
 *   - Billing weeks are composed from Mon–Sat only. A holiday inside a week
 *     does not reshape the week; that would make period boundaries depend on a
 *     holiday table and stop clients and 8338 from agreeing on what a "week" is
 *     just by looking at a calendar.
 *   - Send and review days *do* skip holidays, because they are days on which
 *     somebody has to actually do something.
 *
 * Monthly cut-off windows are plain calendar ranges and skip nothing — the
 * spec's own Cut-off 1 example runs the 28th–30th across Sunday 29 March 2026.
 */

/** A calendar day with no time and no zone, `YYYY-MM-DD`. */
export type Day = string

/** An inclusive range of calendar days. */
export interface DateWindow {
  start: Day
  end: Day
}

export type BillingMode = 'weekly' | 'monthly'

export interface WeeklyPeriod {
  mode: 'weekly'
  periodStart: Day
  periodEnd: Day
  /** Mon–Sat days covered. 6 normally, 7–10 when a month-end tail was absorbed. */
  operatingDays: number
  /** True when a 1–4 day tail at the end of the month was merged into this week. */
  merged: boolean
  /** First working day after the week closes; 8338 sends the summary here. */
  summarySendDay: Day
  /** The client's 3 working days to approve or reject, starting the day after the send. */
  reviewWindow: DateWindow
}

export interface MonthlyPeriod {
  mode: 'monthly'
  cutoffNo: 1 | 2
  periodStart: Day
  periodEnd: Day
  consolidationWindow: DateWindow
  submissionWindow: DateWindow
  validationWindow: DateWindow
}

/** Sunday = 0 … Saturday = 6, matching `Date.prototype.getUTCDay`. */
const SUNDAY = 0
const FRIDAY = 5
const SATURDAY = 6

/** How many working days the client gets to review a weekly summary. */
const WEEKLY_REVIEW_DAYS = 3

/**
 * A month-end remainder of this many operating days or fewer is absorbed into
 * the preceding week rather than being billed on its own.
 */
const MAX_MERGEABLE_TAIL = 4

/** Answers whether a given day is a non-working holiday. */
export type HolidayPredicate = (day: Day) => boolean

const NO_HOLIDAYS: HolidayPredicate = () => false

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function parse(day: Day): Date {
  if (!DAY_PATTERN.test(day)) {
    throw new Error(`billing-calendar: expected a YYYY-MM-DD day, got "${day}"`)
  }
  const [y, m, d] = day.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  // Rejects the likes of 2026-02-31, which Date.UTC would silently roll forward.
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) {
    throw new Error(`billing-calendar: "${day}" is not a real calendar date`)
  }
  return at
}

function format(at: Date): Day {
  return at.toISOString().slice(0, 10)
}

/** The day `n` days after `day`. Negative `n` walks backwards. */
export function addDays(day: Day, n: number): Day {
  const at = parse(day)
  at.setUTCDate(at.getUTCDate() + n)
  return format(at)
}

/** Sunday = 0 … Saturday = 6. */
export function weekday(day: Day): number {
  return parse(day).getUTCDay()
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: Day, to: Day): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000)
}

/** Last calendar day of the given month. `month` is 1-based. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Day `d` of the given month, pulled back to the month's last day when it
 * overflows. This is what keeps Cut-off 1's "28th–30th" validation window from
 * running off the end of February.
 */
export function clampToMonth(year: number, month: number, d: number): Day {
  const day = Math.min(d, lastDayOfMonth(year, month))
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** True when 8338 operates on this day: Mon–Sat, and not a holiday. */
export function isOperatingDay(day: Day, isHoliday: HolidayPredicate = NO_HOLIDAYS): boolean {
  return weekday(day) !== SUNDAY && !isHoliday(day)
}

/** `day` itself when it is a working day, otherwise the next one. */
export function operatingDayOnOrAfter(day: Day, isHoliday: HolidayPredicate = NO_HOLIDAYS): Day {
  let cursor = day
  // A run of 14 consecutive non-working days is not a real calendar; bail
  // rather than spin, so a malformed holiday table fails loudly.
  for (let i = 0; i < 14; i++) {
    if (isOperatingDay(cursor, isHoliday)) return cursor
    cursor = addDays(cursor, 1)
  }
  throw new Error(`billing-calendar: no operating day within 14 days of ${day}`)
}

/**
 * The first Friday on or after `day` — the entire "8338 only accepts payment on
 * Fridays" rule.
 *
 * Every case in the spec collapses into this one expression. A term ending
 * Mon–Thu is due that same week's Friday; a term ending on a Friday is due that
 * day; and Saturday and Sunday both push to the Friday of the following week,
 * because the week turns over on Sunday.
 */
export function nextFridayOnOrAfter(day: Day): Day {
  return addDays(day, (FRIDAY - weekday(day) + 7) % 7)
}

/**
 * When payment falls due for an invoice.
 *
 * The clock starts at Service Invoice issuance for both billing modes, runs for
 * the agreed term in calendar days, then rounds forward to a Friday.
 */
export function dueDateFor(invoiceDate: Day, termDays: number): Day {
  if (![30, 45, 60].includes(termDays)) {
    throw new Error(`billing-calendar: payment term must be 30, 45 or 60 days, got ${termDays}`)
  }
  return nextFridayOnOrAfter(addDays(invoiceDate, termDays))
}

/** The day the term itself expires, before the Friday rule is applied. */
export function termEndDate(invoiceDate: Day, termDays: number): Day {
  return addDays(invoiceDate, termDays)
}

/**
 * Billing weeks for a month, in order.
 *
 * A week runs Monday to Saturday and never crosses a month boundary. If the
 * final stub of the month holds 1–4 operating days it is absorbed backwards
 * into the week before it, producing one long week instead of a token one.
 *
 * The rule as written in the contract governs only the *last* week of a month,
 * so a short week at the *start* of a month stands on its own: April 2026 opens
 * with Wed 1 – Sat 4 as a billing week in its own right, while March closes with
 * a merged Mar 23–31.
 */
export function buildWeeklyPeriods(
  year: number,
  month: number,
  isHoliday: HolidayPredicate = NO_HOLIDAYS,
): WeeklyPeriod[] {
  const lastDay = lastDayOfMonth(year, month)

  // Group the month's Mon–Sat days into runs, breaking at each Sunday.
  const runs: Day[][] = []
  let current: Day[] = []
  for (let d = 1; d <= lastDay; d++) {
    const day = clampToMonth(year, month, d)
    if (weekday(day) === SUNDAY) {
      if (current.length) runs.push(current)
      current = []
      continue
    }
    current.push(day)
    if (weekday(day) === SATURDAY) {
      runs.push(current)
      current = []
    }
  }
  if (current.length) runs.push(current)

  // Absorb a short month-end tail into the week before it.
  let merged = false
  if (runs.length > 1) {
    const tail = runs[runs.length - 1]
    if (tail.length <= MAX_MERGEABLE_TAIL) {
      runs.pop()
      runs[runs.length - 1] = runs[runs.length - 1].concat(tail)
      merged = true
    }
  }

  return runs.map((run, i) => {
    const periodEnd = run[run.length - 1]
    const summarySendDay = operatingDayOnOrAfter(addDays(periodEnd, 1), isHoliday)

    // Three working days for the client, starting the day after the summary lands.
    let cursor = summarySendDay
    const reviewDays: Day[] = []
    while (reviewDays.length < WEEKLY_REVIEW_DAYS) {
      cursor = operatingDayOnOrAfter(addDays(cursor, 1), isHoliday)
      reviewDays.push(cursor)
    }

    return {
      mode: 'weekly' as const,
      periodStart: run[0],
      periodEnd,
      operatingDays: run.length,
      merged: merged && i === runs.length - 1,
      summarySendDay,
      reviewWindow: { start: reviewDays[0], end: reviewDays[reviewDays.length - 1] },
    }
  })
}

/**
 * The two monthly cut-offs for a month.
 *
 * Cut-off 1 covers the 1st–15th and is worked entirely within the same month.
 * Cut-off 2 covers the 16th to month end and is worked in the following month.
 * Window days are calendar days and are not moved off Sundays; only the
 * validation window can overflow a short month, and it clamps to month end.
 */
export function buildMonthlyCutoffs(year: number, month: number): [MonthlyPeriod, MonthlyPeriod] {
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year

  const first: MonthlyPeriod = {
    mode: 'monthly',
    cutoffNo: 1,
    periodStart: clampToMonth(year, month, 1),
    periodEnd: clampToMonth(year, month, 15),
    consolidationWindow: {
      start: clampToMonth(year, month, 16),
      end: clampToMonth(year, month, 18),
    },
    submissionWindow: {
      start: clampToMonth(year, month, 25),
      end: clampToMonth(year, month, 27),
    },
    validationWindow: {
      start: clampToMonth(year, month, 28),
      end: clampToMonth(year, month, 30),
    },
  }

  const second: MonthlyPeriod = {
    mode: 'monthly',
    cutoffNo: 2,
    periodStart: clampToMonth(year, month, 16),
    periodEnd: clampToMonth(year, month, lastDayOfMonth(year, month)),
    consolidationWindow: {
      start: clampToMonth(nextYear, nextMonth, 1),
      end: clampToMonth(nextYear, nextMonth, 3),
    },
    submissionWindow: {
      start: clampToMonth(nextYear, nextMonth, 10),
      end: clampToMonth(nextYear, nextMonth, 12),
    },
    validationWindow: {
      start: clampToMonth(nextYear, nextMonth, 13),
      end: clampToMonth(nextYear, nextMonth, 15),
    },
  }

  return [first, second]
}

/**
 * The cut-off whose submission window a late billing rolls into.
 *
 * A client who misses their window does not lose the billing — it is picked up
 * by the next cycle, and the payment date moves with it. Cut-off 1 of March
 * rolls into cut-off 2 of March (submitted 10–12 April); cut-off 2 of March
 * rolls into cut-off 1 of April (submitted 25–27 April).
 */
export function rolloverTarget(period: MonthlyPeriod): MonthlyPeriod {
  const [y, m] = period.periodStart.split('-').map(Number)
  if (period.cutoffNo === 1) return buildMonthlyCutoffs(y, m)[1]
  const nextMonth = m === 12 ? 1 : m + 1
  const nextYear = m === 12 ? y + 1 : y
  return buildMonthlyCutoffs(nextYear, nextMonth)[0]
}

/** True when `day` falls inside `window`, inclusive of both ends. */
export function isWithin(day: Day, window: DateWindow): boolean {
  return day >= window.start && day <= window.end
}

/**
 * The billing period a completed booking belongs to, keyed on its service date.
 *
 * `bookings.schedule_date` is the right anchor rather than an actual completion
 * timestamp: the contract bills "operating days Monday to Saturday", so a job
 * scheduled on the Saturday belongs to that Saturday's week even if the paperwork
 * closed on the Monday.
 */
export function periodBoundsFor(
  scheduleDate: Day,
  mode: BillingMode,
  isHoliday: HolidayPredicate = NO_HOLIDAYS,
): WeeklyPeriod | MonthlyPeriod {
  const [y, m, d] = scheduleDate.split('-').map(Number)

  if (mode === 'monthly') {
    const [first, second] = buildMonthlyCutoffs(y, m)
    return d <= 15 ? first : second
  }

  const week = buildWeeklyPeriods(y, m, isHoliday).find(
    (w) => scheduleDate >= w.periodStart && scheduleDate <= w.periodEnd,
  )
  if (!week) {
    // Only reachable for a Sunday, on which 8338 does not operate and so cannot
    // have a completed booking.
    throw new Error(`billing-calendar: ${scheduleDate} falls outside every billing week`)
  }
  return week
}

/**
 * The payment term a booking was made under.
 *
 * There is no longer any term to "resolve": a Service Invoice covers exactly one
 * booking, so it simply carries that booking's own term. This only normalises
 * the value, which is stored as free text on `bookings.payment_terms`, and falls
 * back to the shortest term when a booking predates the dropdown — erring
 * towards billing sooner rather than granting credit nobody agreed to.
 */
export function bookingTermDays(raw: string | number | null | undefined): 30 | 45 | 60 {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/\D/g, ''))
  return n === 45 || n === 60 ? n : 30
}
