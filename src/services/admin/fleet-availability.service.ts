import { supabase } from '../../lib/supabase.js'
import { reconcileDriverStatus } from '../../lib/driver-reservation.js'
import { driverCalendarAllows } from '../driver/availability.service.js'
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
 * States that stop a driver working whatever their calendar says. Everything
 * else — including the legacy 'available'/'unavailable' left over from the old
 * on/off switch — means "not stopped", and the calendar decides from there.
 */
const BLOCKING_DRIVER_STATUSES: Record<string, string> = {
  assigned: 'is already out on another delivery',
  on_leave: 'is on leave',
  inactive: 'has been deactivated',
}

/**
 * Throws unless the driver can be put on this booking. `currentDriverId` is the
 * driver already on it, who stays valid while the assignment is edited (they
 * read as 'assigned', which would otherwise block them).
 *
 * Two things have to hold, and the second is the driver's own word: nothing has
 * stopped them working at all, and they ticked this booking's day on their
 * calendar. The tick is the whole opt-in — a driver who ticked nothing can be
 * assigned nothing.
 */
export async function assertDriverAssignable(
  driverId: string,
  currentDriverId?: string | null,
  scheduleDate?: string | null,
): Promise<void> {
  if (driverId === currentDriverId) return

  const { data, error } = await supabase
    .from('drivers')
    .select('status')
    .eq('driver_id', driverId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Driver with ID ${driverId} not found`)

  // A driver still flagged 'assigned' from a delivery that no longer exists is
  // not busy, just stuck — clear that before it reads as a refusal and quietly
  // keeps them out of the pool for good.
  const status  = await reconcileDriverStatus(driverId, data.status)
  const blocked = BLOCKING_DRIVER_STATUSES[status]
  if (blocked) throw new Error(`This driver ${blocked} and cannot be assigned`)

  if (!(await driverCalendarAllows(driverId, scheduleDate))) {
    throw new Error(
      `This driver did not mark ${String(scheduleDate).slice(0, 10)} as a day they can work — they can only be assigned to days they ticked on their calendar`,
    )
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
 * The driver always lands back on 'available', which now means only "not
 * reserved" — the calendar, not this column, decides what they can be given
 * next. It used to matter whether they had actually driven: finishing a delivery
 * dropped them to 'unavailable' so they had to flip their switch back on before
 * being re-assigned. With the switch gone there is nothing to flip back, and
 * leaving them 'unavailable' would just be a word nothing reads. A driver who
 * does not want the next day's work says so by not ticking the day.
 */
export async function releaseCrew(driverId: string | null, truckId: string | null): Promise<void> {
  if (driverId) await setDriverStatus(driverId, 'available')
  if (truckId)  await setTruckStatus(truckId, 'available')
}

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
