import { supabase } from '../../lib/supabase.js'
import type { BlowbagetsItems } from '../../types/client/booking.types.js'

/**
 * Availability rules shared by the assignment flow and the booking lifecycle.
 *
 * Two pools gate what operations can pick:
 *   - drivers  — only those who have switched themselves to 'available' in the
 *                mobile app. A new driver starts 'unavailable' and opts in.
 *   - vehicles — only those whose MOST RECENT BLOWBAGETS inspection passed. The
 *                fleet manager records inspections in Vehicle Management; a pass
 *                holds until a newer inspection replaces it.
 *
 * Assigning reserves both (driver -> 'assigned', truck -> 'in_use'); finishing or
 * cancelling the booking releases them (driver -> 'unavailable' so they must opt
 * back in, truck -> 'available').
 */

export interface TruckInspectionRow {
  inspection_id: string
  truck_id:      string
  items:         BlowbagetsItems
  passed:        boolean
  notes:         string | null
  inspected_by:  string | null
  inspected_at:  string
  created_at:    string
}

/** The latest inspection for each of the given trucks (missing = never inspected). */
export async function latestInspectionsFor(truckIds: string[]): Promise<Map<string, TruckInspectionRow>> {
  const byTruck = new Map<string, TruckInspectionRow>()
  if (truckIds.length === 0) return byTruck

  const { data, error } = await supabase
    .from('truck_inspections')
    .select('*')
    .in('truck_id', truckIds)
    .order('inspected_at', { ascending: false })

  if (error) throw error
  // Rows arrive newest-first, so the first row seen per truck is the latest.
  for (const row of (data ?? []) as TruckInspectionRow[]) {
    if (!byTruck.has(row.truck_id)) byTruck.set(row.truck_id, row)
  }
  return byTruck
}

export async function latestInspectionFor(truckId: string): Promise<TruckInspectionRow | null> {
  return (await latestInspectionsFor([truckId])).get(truckId) ?? null
}

/** Throws unless the truck's latest BLOWBAGETS inspection is a pass. */
export async function assertTruckPassedInspection(truckId: string): Promise<void> {
  const latest = await latestInspectionFor(truckId)
  if (!latest) {
    throw new Error('This vehicle has not been inspected yet — the fleet manager must run a BLOWBAGETS check before it can be assigned')
  }
  if (!latest.passed) {
    throw new Error('This vehicle failed its last BLOWBAGETS inspection and cannot be assigned until it passes a re-check')
  }
}

/**
 * Throws unless the driver is in the assignable pool. `currentDriverId` is the
 * driver already on this booking, who stays valid while the assignment is edited
 * (they are 'assigned', not 'available').
 */
export async function assertDriverAssignable(
  driverId: string,
  currentDriverId?: string | null,
): Promise<void> {
  if (driverId === currentDriverId) return

  const { data, error } = await supabase
    .from('drivers')
    .select('status')
    .eq('driver_id', driverId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Driver with ID ${driverId} not found`)
  if (data.status !== 'available') {
    throw new Error(`This driver is not available (status: ${data.status}) — only drivers who marked themselves available can be assigned`)
  }
}

async function setDriverStatus(driverId: string, status: string): Promise<void> {
  const { error } = await supabase.from('drivers').update({ status, updated_at: new Date().toISOString() }).eq('driver_id', driverId)
  if (error) throw error
}

async function setTruckStatus(truckId: string, status: string): Promise<void> {
  const { error } = await supabase.from('trucks').update({ status, updated_at: new Date().toISOString() }).eq('truck_id', truckId)
  if (error) throw error
}

/** Take the driver + vehicle out of the pool for the duration of the delivery. */
export async function reserveCrew(driverId: string | null, truckId: string | null): Promise<void> {
  if (driverId) await setDriverStatus(driverId, 'assigned')
  if (truckId)  await setTruckStatus(truckId, 'in_use')
}

/**
 * Put the vehicle back in the pool and take the driver off the booking.
 *
 * Where the driver lands depends on whether they actually worked:
 *   'unavailable' — they finished a delivery. They are prompted in the app to opt
 *                   back in when they are ready for the next one, so a tired
 *                   driver is never silently re-assigned.
 *   'available'   — they were taken off the booking without driving it (the
 *                   booking was cancelled, or operations swapped them out), so
 *                   they stay in the pool they had opted into.
 */
export async function releaseCrew(
  driverId: string | null,
  truckId: string | null,
  driverTo: DriverAvailabilityAfterRelease = 'unavailable',
): Promise<void> {
  if (driverId) await setDriverStatus(driverId, driverTo)
  if (truckId)  await setTruckStatus(truckId, 'available')
}

export type DriverAvailabilityAfterRelease = 'unavailable' | 'available'

/** The driver + truck currently recorded on a booking's delivery, if any. */
export async function crewOnBooking(bookingId: string): Promise<{ driver_id: string | null; truck_id: string | null }> {
  const { data, error } = await supabase
    .from('deliveries')
    .select('driver_id, truck_id')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return { driver_id: data?.driver_id ?? null, truck_id: data?.truck_id ?? null }
}
