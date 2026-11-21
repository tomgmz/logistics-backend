/**
 * Office hours for client-facing replies: Monday to Saturday, 8 AM to 5 PM,
 * Manila time (bookings use the same hours, see booking.service). Transit runs
 * every day; this is only when the office answers.
 *
 * Not a holiday calendar: a public holiday or a typhoon suspension counts as
 * open (docs/loophole-register.md).
 */

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000
const OPEN_HOUR  = 8
const CLOSE_HOUR = 17

/** Manila wall clock for an instant, as a UTC-based Date (read with getUTC*). */
const manila = (d: Date) => new Date(d.getTime() + MANILA_OFFSET_MS)

export function isOfficeOpen(now = new Date()): boolean {
  const m   = manila(now)
  const day = m.getUTCDay()           // 0 = Sunday
  const h   = m.getUTCHours()
  return day !== 0 && h >= OPEN_HOUR && h < CLOSE_HOUR
}

/** When the office last closed (5 PM of the latest Mon–Sat at or before now). */
export function lastClosing(now = new Date()): Date {
  const m = manila(now)
  for (let back = 0; back < 8; back++) {
    const day = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() - back, CLOSE_HOUR))
    if (day.getUTCDay() === 0) continue
    const closingUtc = new Date(day.getTime() - MANILA_OFFSET_MS)
    if (closingUtc <= now) return closingUtc
  }
  return new Date(now.getTime() - 7 * 24 * 3600_000)
}

/** The office phone, as on the landing page and in the assistant's knowledge. */
export const OFFICE_PHONE = '+63 9685 536 8975'

export const AFTER_HOURS_TEXT =
  'Our team is in Monday to Saturday, 8 AM to 5 PM, and will reply here when we are back. ' +
  `For a problem with a delivery on the road right now, call us at ${OFFICE_PHONE}.`
