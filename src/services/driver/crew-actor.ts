import { supabase } from '../../lib/supabase.js'
import type { DriverActor } from '../client/booking.service.js'

/**
 * drivers.driver_id of the signed-in driver, for stamping who confirmed a stop.
 * Null for an admin acting on a driver's behalf, or when the lookup fails — a
 * missing attribution never blocks a confirmation.
 */
export async function driverIdOf(actor: DriverActor): Promise<string | null> {
  if (!actor.userId || actor.role === 'admin') return null
  const { data } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('user_id', actor.userId)
    .maybeSingle()
  return (data?.driver_id as string | undefined) ?? null
}

/** The load transfer still owed after a crew replacement, if any. */
export async function pendingLoadTransfer(bookingId: string) {
  const { data, error } = await supabase
    .from('crew_replacements')
    .select('replacement_id, booking_id, trip_id, old_truck_id, old_vehicle_plate, handover_latitude, handover_longitude, replaced_at, old_truck:trucks!crew_replacements_old_truck_id_fkey ( plate_number )')
    .eq('booking_id', bookingId)
    .eq('transfer_required', true)
    .is('transfer_confirmed_at', null)
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Refuses a drop-off while the load is still on the replaced vehicle. Worded
 * "Confirm the …" so the controllers answer 409, which the phone's queue keeps
 * and retries once the transfer has gone through ahead of it.
 */
export async function assertNoPendingLoadTransfer(bookingId: string): Promise<void> {
  if (await pendingLoadTransfer(bookingId)) {
    throw new Error('Confirm the load transfer onto the new vehicle before unloading at a drop-off')
  }
}
