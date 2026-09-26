import { supabase } from '../../lib/supabase.js'
import {
  reconcileDriverStatus,
  awaitingFleetReturn,
  truckAwaitingFleetReturn,
  lastFleetReturnFor,
} from '../../lib/driver-reservation.js'
import { driverCalendarAllows } from '../driver/availability.service.js'
import type { BlowbagetsItems } from '../../types/client/booking.types.js'
import { logEvent } from '../../lib/log-event.js'

/**
 * Availability rules shared by the assignment flow and the booking lifecycle.
 *
 * Two pools gate what operations can pick:
 *   - drivers  — only those who have switched themselves to 'available' in the
 *                mobile app. A new driver starts 'unavailable' and opts in.
 *   - vehicles — only those whose MOST RECENT BLOWBAGETS inspection passed AND
 *                was recorded since the vehicle last came home. The fleet
 *                manager records inspections in Vehicle Management, and a pass
 *                clears the vehicle for one job: it expires the moment the
 *                truck returns to the yard, so every booking is preceded by a
 *                fresh check.
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
    throw new Error('This vehicle has not been inspected yet — the Fleet Manager must run a BLOWBAGETS check before it can be assigned')
  }
  if (!latest.passed) {
    throw new Error('This vehicle failed its last BLOWBAGETS inspection and cannot be assigned until it passes a re-check')
  }
}

/**
 * Throws unless the vehicle can be put on this booking. `currentTruckId` is the
 * vehicle already on it, which stays valid while the assignment is edited.
 *
 * The mirror of `assertDriverAssignable`, and it exists for the same reason: a
 * booking is completed when the cargo is off, but the truck is still at the last
 * drop-off until someone confirms it is back in the 8338 lot. `trucks.status` is
 * no help — `releaseCrew` set it to 'available' at completion, and no assignment
 * path reads it anyway. Without this a vehicle that is physically out gets
 * offered to the next booking.
 */
export async function assertTruckAssignable(
  truckId: string,
  currentTruckId?: string | null,
): Promise<void> {
  await assertTruckPassedInspection(truckId)

  if (truckId === currentTruckId) return

  const unreturned = await truckAwaitingFleetReturn(truckId)
  if (unreturned) {
    throw new Error(
      `This vehicle has not been confirmed back in the 8338 parking lot for booking ` +
      `${unreturned.reference_number ?? unreturned.booking_id} — it cannot be assigned until it is returned`,
    )
  }

  await assertInspectedSinceLastReturn(truckId)
}

/**
 * Throws unless the vehicle has passed a BLOWBAGETS check since it last came
 * home.
 *
 * A pass is not permanent. It clears the vehicle for the job in front of it, and
 * a truck that has just done a run has been loaded, driven and unloaded since
 * anyone last looked at its brakes. So the clearance expires on return, and the
 * fleet manager inspects it again before it goes out.
 *
 * A vehicle that has never been out is unaffected — there is no return to be
 * newer than, so its first passing inspection stands.
 */
async function assertInspectedSinceLastReturn(truckId: string): Promise<void> {
  const lastReturn = await lastFleetReturnFor(truckId)
  if (!lastReturn) return

  const latest = await latestInspectionFor(truckId)
  // `assertTruckPassedInspection` has already established there is a passing
  // one; this only asks whether it is recent enough.
  if (latest && latest.inspected_at > lastReturn) return

  throw new Error(
    'This vehicle has been back in the yard since its last BLOWBAGETS check — ' +
    'the Fleet Manager must inspect it again before it can be assigned',
  )
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
 * Three things have to hold, and the last is the driver's own word: nothing has
 * stopped them working at all, they are not still holding a vehicle from a
 * finished booking, and they ticked this booking's day on their calendar. The
 * tick is the whole opt-in — a driver who ticked nothing can be assigned
 * nothing.
 */
export async function assertDriverAssignable(
  driverId: string,
  currentDriverId?: string | null,
  scheduleDate?: string | null,
): Promise<void> {
  if (driverId === currentDriverId) return

  const { data, error } = await supabase
    .from('drivers')
    .select('status, is_external')
    .eq('driver_id', driverId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Driver with ID ${driverId} not found`)

  // An external driver belongs to a vendor, not the fleet. They are filtered out
  // of the picker already, but this is the gate that a hand-crafted driver_id
  // has to get past — and the company path's guarantees (a vetted licence, a
  // ticked calendar, BLOWBAGETS on the paired vehicle) do not apply to them.
  if (data.is_external) {
    throw new Error('This is a vendor-supplied driver and cannot be assigned as company crew')
  }

  // A driver still flagged 'assigned' from a delivery that no longer exists is
  // not busy, just stuck — clear that before it reads as a refusal and quietly
  // keeps them out of the pool for good.
  const status  = await reconcileDriverStatus(driverId, data.status)
  const blocked = BLOCKING_DRIVER_STATUSES[status]
  if (blocked) throw new Error(`This driver ${blocked} and cannot be assigned`)

  // Checked before the calendar: a driver who finished a delivery but has not
  // brought the vehicle back is holding it, and their status says 'available'
  // because completion released the crew. Ticking today changes nothing while
  // the truck is still out — one driver, one booking, until it is home.
  const unreturned = await awaitingFleetReturn(driverId)
  if (unreturned) {
    throw new Error(
      `This driver has not confirmed the vehicle's return to the 8338 parking lot for booking ` +
      `${unreturned.reference_number ?? unreturned.booking_id} — they cannot take another booking until it is back`,
    )
  }

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

  // These silently change who is available. When a booking cannot be staffed,
  // this pair of events is the trail that explains why.
  logEvent({
    log_type:    'vehicle_activity',
    action:      'crew_reserved',
    description: `Reserved driver ${driverId ?? '—'} / vehicle ${truckId ?? '—'}`,
  })
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

  logEvent({
    log_type:    'vehicle_activity',
    action:      'crew_released',
    description: `Released driver ${driverId ?? '—'} / vehicle ${truckId ?? '—'}`,
  })
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
