import { supabase } from './supabase.js'

/**
 * The booking number people quote.
 *
 * `reference_number` IS the booking number — a `BEFORE INSERT` trigger
 * (`trg_booking_reference`) assigns one to every row, so in practice it is
 * always there. `booking_id` is an internal UUID and must never be what a user
 * reads, whether in a notification, an audit-log line or a screen. The `#`-
 * prefixed UUID slice below is a defensive fallback only, marked so nobody
 * mistakes an internal id for a real reference.
 *
 * The web and mobile clients carry the same rule — keep the three in step.
 */
export function bookingRef(
  booking: { reference_number?: string | null; booking_id?: string | null } | null | undefined,
): string {
  if (!booking) return ''

  const ref = booking.reference_number
  if (typeof ref === 'string' && ref.trim() !== '') return ref.trim()

  const id = booking.booking_id
  return id ? `#${id.slice(0, 8).toUpperCase()}` : ''
}

/**
 * The booking's key in a web address: the reference without "BK-", e.g.
 * `202611-00193` (YYYYMM in Philippine time + that month's count, from the
 * trg_booking_reference trigger). Internal ids never go in an address.
 * Accepts "BK-202611-00193" too, any case. null when it isn't one.
 */
export const BOOKING_URL_KEY = /^(?:BK-)?(\d{6})-(\d{1,9})$/i

export function referenceFromUrlKey(key: string): string | null {
  const m = BOOKING_URL_KEY.exec(key.trim())
  if (!m) return null
  // The trigger pads to 5 digits; a link typed as "202611-193" still finds it.
  return `BK-${m[1]}-${m[2].padStart(5, '0')}`
}

/**
 * What goes after `?booking=` in a link: `202611-00193`. A booking with no
 * reference (shouldn't happen: the trigger always sets one) falls back to its
 * id, which the web still opens.
 */
export function bookingUrlKey(reference: string | null | undefined, bookingId: string): string {
  const ref = reference ? referenceFromUrlKey(reference) : null
  return ref ? ref.slice(3) : bookingId
}

/** booking_id for a reference (or URL key), or null. No ownership check: callers check it. */
export async function bookingIdByReference(key: string): Promise<string | null> {
  const ref = referenceFromUrlKey(key)
  if (!ref) return null
  const { data, error } = await supabase
    .from('bookings')
    .select('booking_id')
    .eq('reference_number', ref)
    .maybeSingle()
  if (error) throw error
  return (data?.booking_id as string | undefined) ?? null
}

/**
 * Same rule, when only the id is in scope. Reads one column, and falls back to
 * the marked id slice rather than throwing — an audit line must still be written
 * if this lookup fails.
 */
export async function bookingRefById(bookingId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('bookings')
      .select('reference_number')
      .eq('booking_id', bookingId)
      .maybeSingle()

    return bookingRef({ reference_number: data?.reference_number, booking_id: bookingId })
  } catch {
    return bookingRef({ booking_id: bookingId })
  }
}
