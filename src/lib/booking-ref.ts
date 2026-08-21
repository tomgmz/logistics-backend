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
