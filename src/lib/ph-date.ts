/**
 * Philippine calendar days.
 *
 * `bookings.schedule_date` is a plain `date` column — a calendar day with no
 * time and no zone — so the only correct thing to compare it against is the
 * calendar day in the operation's own timezone, never the server's UTC day and
 * never a client device's idea of today.
 *
 * The Philippines is a fixed UTC+8 with no DST, so a constant offset is exact
 * here and avoids depending on the host's timezone database.
 */
const PH_OFFSET_MS = 8 * 60 * 60 * 1000

/** Today in Philippine time, as `YYYY-MM-DD`. */
export function phDay(at: Date | number = Date.now()): string {
  const ms = typeof at === 'number' ? at : at.getTime()
  return new Date(ms + PH_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * The same calendar day one month on, in Philippine time, as `YYYY-MM-DD`.
 * The latest day a booking can be scheduled for. A day that doesn't exist next
 * month (Jan 31) rolls to the next month's last day rather than overflowing.
 */
export function phDayPlusMonth(at: Date | number = Date.now()): string {
  const ms   = typeof at === 'number' ? at : at.getTime()
  const d    = new Date(ms + PH_OFFSET_MS)
  const day  = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + 1)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}

/**
 * Same-day bookings close at 12:00 noon, Manila time, so the office (Monday to
 * Saturday, 8 AM – 5 PM) still has the afternoon to review and dispatch them.
 * Sunday has no office, so it never offers today.
 */
export const SAME_DAY_CUTOFF_HOUR = 12

export function sameDayBookingOpen(at: Date | number = Date.now()): boolean {
  const ms = typeof at === 'number' ? at : at.getTime()
  const ph = new Date(ms + PH_OFFSET_MS)
  return ph.getUTCDay() !== 0 && ph.getUTCHours() < SAME_DAY_CUTOFF_HOUR
}

/** The current Manila wall-clock time as `HH:MM`, comparable with `call_time`. */
export function phTimeHHMM(at: Date | number = Date.now()): string {
  const ms = typeof at === 'number' ? at : at.getTime()
  return new Date(ms + PH_OFFSET_MS).toISOString().slice(11, 16)
}

/** A `date` value from the database, normalised to `YYYY-MM-DD`. */
export function asDay(value: string | Date | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return phDay(value)
  const trimmed = String(value).trim()
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : null
}

/**
 * True when the booking's scheduled day is still in the future.
 *
 * Deliberately "not before" rather than "is today": a booking whose day has
 * already passed must stay runnable, or a job that slipped by a day strands the
 * driver. A missing date never blocks.
 */
export function isBeforeScheduledDay(
  scheduleDate: string | Date | null | undefined,
  at: Date | number = Date.now(),
): boolean {
  const scheduled = asDay(scheduleDate)
  if (!scheduled) return false
  return scheduled > phDay(at)
}
