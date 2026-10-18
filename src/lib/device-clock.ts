import { getRequestContext } from './request-context.js'

/**
 * A time the driver's phone recorded, moved onto the server's clock.
 *
 * The phone's clock is the driver's to set, and it can simply be wrong — three
 * hours ahead, a day behind. Every request from the app carries the phone's
 * clock at the moment it was SENT (`X-Device-Time`), so the server knows how far
 * off that clock is right now and corrects a time the phone recorded earlier by
 * the same amount: a tap at 12:40 phone time, sent from a phone 3 h ahead, is
 * 09:40. That holds however long the tap sat in the offline queue and across
 * app restarts — it needs no earlier sync, only the clock not being changed
 * between the tap and the send. Callers still bound the result (never in the
 * future, never before the step before it) for that one case.
 *
 * Without the header (the web, an older app) the time is read as given.
 * Null when `iso` is not a time.
 */
export function fromDeviceClock(iso: string | null | undefined): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const skew = getRequestContext()?.deviceSkewMs
  return skew == null ? at : at + skew
}

/** Whether this request told us the phone's clock (so its times were corrected). */
export function hasDeviceClock(): boolean {
  return getRequestContext()?.deviceSkewMs != null
}
