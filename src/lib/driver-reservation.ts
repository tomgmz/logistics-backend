import { supabase } from './supabase.js'

/**
 * Whether the driver is actually out on a delivery right now.
 *
 * `drivers.status = 'assigned'` is a reservation flag, not a fact: operations
 * sets it when a booking is crewed and the booking's end clears it. Anything
 * that removes the delivery without going through that release path — a booking
 * deleted straight out of the database, an assignment that half-finished —
 * leaves the flag set with nothing behind it, and the driver is then stranded:
 * they cannot toggle out of 'assigned' themselves, and operations cannot assign
 * them because the pool only takes 'available'. This is the question that tells
 * a real delivery from a leftover flag.
 */

/** Bookings that are over. A delivery on one of these holds nobody. */
const FINISHED_BOOKING_STATUSES = ['completed', 'cancelled']

export async function hasLiveDelivery(driverId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('deliveries')
    .select('delivery_id, bookings ( status )')
    .eq('driver_id', driverId)

  if (error) throw error

  return (data ?? []).some((row: any) => {
    const status = row.bookings?.status
    // A delivery whose booking is gone is itself an orphan — exactly the state
    // this guards against, so it counts for nothing.
    if (!status) return false
    return !FINISHED_BOOKING_STATUSES.includes(status)
  })
}

/**
 * The driver's status with a stale reservation cleared.
 *
 * Returns what `drivers.status` should say right now, writing the correction
 * back when the stored value reserves a driver no delivery is holding. They
 * never drove, so they land on 'available' — the same place a driver goes when
 * operations swaps them off a booking, keeping the slot they opted into rather
 * than having to opt in again.
 *
 * Read paths call this so the stranded state heals itself the next time anyone
 * looks, instead of needing a hand-written UPDATE against production.
 */
export async function reconcileDriverStatus(driverId: string, status: string): Promise<string> {
  if (status !== 'assigned') return status
  if (await hasLiveDelivery(driverId)) return status

  const { error } = await supabase
    .from('drivers')
    .update({ status: 'available', updated_at: new Date().toISOString() })
    .eq('driver_id', driverId)
    // Only if it is still what we just read — another request may have crewed
    // them in the meantime, and that reservation is real.
    .eq('status', 'assigned')

  if (error) throw error

  console.warn(`[fleet] cleared a stale 'assigned' reservation on driver ${driverId} — no live delivery behind it`)
  return 'available'
}
