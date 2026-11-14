import { supabase } from './supabase.js'
import { sendVendorDriverAssignedEmail } from './brevo-mailer.js'

/**
 * Vendor drivers get app access per booking (user 2026-11-14, the Onfleet /
 * Shipday contractor model): the account stays Active, but signing in and using
 * the app needs an open booking they are on (main or second driver). Once the
 * last one is Completed, Failed or Cancelled, or the office takes them off it,
 * they are signed out; assigning them again lets them back in, with no account
 * switch by anyone.
 *
 * Checked in three places, so every path is covered whatever closed the booking:
 * sign-in (createTokensAndSession: password, emailed code, passkey), the token
 * refresh, and every request (authenticate, cached 60 s).
 *
 * Fails OPEN on a database error: a hiccup must never sign a driver out in the
 * middle of a delivery; the next check catches a driver who really has none.
 */

export const NO_ACTIVE_ASSIGNMENT = 'NO_ACTIVE_ASSIGNMENT'
export const NO_ACTIVE_ASSIGNMENT_MESSAGE =
  'You have no delivery assigned right now. You can sign in again once 8338 assigns you to a booking.'

/** Booking statuses that still need the driver: on the road, or delivered and awaiting the client. */
const OPEN_STATUSES = ['assigned', 'in_transit', 'delivered']

/** drivers.is_external never changes for an account, so it is kept for a while. */
const vendorCache = new Map<string, { vendorDriverId: string | null; at: number }>()
const VENDOR_TTL_MS = 10 * 60_000

/** The vendor driver's drivers.driver_id, or null for anyone who isn't one. */
async function vendorDriverIdOf(userId: string): Promise<string | null> {
  const hit = vendorCache.get(userId)
  if (hit && Date.now() - hit.at < VENDOR_TTL_MS) return hit.vendorDriverId
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id, is_external')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  const vendorDriverId = data?.is_external === true ? (data.driver_id as string) : null
  vendorCache.set(userId, { vendorDriverId, at: Date.now() })
  return vendorDriverId
}

/**
 * False only for a vendor driver with no open booking. Company drivers, every
 * other role, and any database error answer true.
 */
export async function vendorMayUseApp(userId: string, role: string): Promise<boolean> {
  if (role !== 'driver') return true
  try {
    const driverId = await vendorDriverIdOf(userId)
    if (!driverId) return true
    const { data, error } = await supabase
      .from('driver_assignments')
      .select('booking_id, bookings!inner ( status )')
      .eq('driver_id', driverId)
      .in('bookings.status', OPEN_STATUSES)
      .limit(1)
    if (error) throw error
    return (data ?? []).length > 0
  } catch (err) {
    console.error('[vendor-access] check failed; letting the request through:', (err as Error)?.message)
    return true
  }
}

/** Per-request answers, so authenticate costs one lookup a minute per driver. */
const requestCache = new Map<string, { ok: boolean; at: number }>()
const REQUEST_TTL_MS = 60_000

export async function vendorMayUseAppCached(userId: string, role: string): Promise<boolean> {
  if (role !== 'driver') return true
  const hit = requestCache.get(userId)
  if (hit && Date.now() - hit.at < REQUEST_TTL_MS) return hit.ok
  const ok = await vendorMayUseApp(userId, role)
  requestCache.set(userId, { ok, at: Date.now() })
  if (requestCache.size > 5000) requestCache.clear()
  return ok
}

/** Forget the cached answer (a fresh sign-in was just allowed). */
export function forgetVendorAccess(userId: string): void {
  requestCache.delete(userId)
}

export function noActiveAssignmentError(): Error {
  return Object.assign(new Error(NO_ACTIVE_ASSIGNMENT_MESSAGE), { code: NO_ACTIVE_ASSIGNMENT })
}

/**
 * Email each vendor driver just put on a booking, so one who was signed out
 * (no push) knows to sign in. Best effort; a failure is only logged.
 */
export function emailVendorDriversAssigned(
  drivers: Array<{ userId: string; firstName: string | null; snapshot: { vendor_driver_email: string } } | null | undefined>,
  booking: { reference_number?: string | null; booking_id: string; schedule_date?: string | null },
): void {
  for (const d of drivers) {
    if (!d?.snapshot?.vendor_driver_email) continue
    forgetVendorAccess(d.userId)
    void sendVendorDriverAssignedEmail({
      to:           d.snapshot.vendor_driver_email,
      firstName:    d.firstName,
      reference:    booking.reference_number ?? booking.booking_id,
      scheduleDate: booking.schedule_date ?? null,
    }).catch((err) => console.error('[vendor-access] assigned email failed', booking.booking_id, (err as Error)?.message))
  }
}
