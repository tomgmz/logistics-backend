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

/**
 * The booking whose vehicle has not been brought back yet.
 *
 * A booking is `completed` when the last box is off the truck, but neither the
 * driver nor the vehicle is free then — they are both wherever the last drop-off
 * was. The job ends when the truck is home, which is what `fleet_return_at`
 * records. Between those two moments `releaseCrew` has already put both back in
 * the pool, so `drivers.status` says 'available', `trucks.status` says
 * 'available', and the calendar may well tick today: nothing in either status
 * column can express "done delivering, still out there". This is that question,
 * asked directly of the booking.
 *
 * One driver, one booking; one truck, one booking. Until the vehicle is back in
 * the 8338 lot neither can be crewed onto anything else.
 *
 * Only 'completed' counts. A 'cancelled' booking never sends the truck out on
 * the strength of that cancellation, and its crew is released deliberately —
 * treating it as unreturned would strand a driver on a job that never ran.
 */
export interface UnreturnedVehicle {
  driver_id:        string | null
  truck_id:         string | null
  booking_id:       string
  reference_number: string | null
}

/**
 * Shared query. Keyed by whichever side of the delivery is being asked about,
 * because the fact is one and the same: this booking is done and its truck is
 * not home.
 */
async function unreturnedBy(
  column: 'driver_id' | 'truck_id',
  ids:    string[],
): Promise<Map<string, UnreturnedVehicle>> {
  const byId = new Map<string, UnreturnedVehicle>()
  if (ids.length === 0) return byId

  const { data, error } = await supabase
    .from('deliveries')
    // `!inner` matters: without it the booking filters below would not restrict
    // which delivery rows come back, only which embeds are populated.
    .select('driver_id, truck_id, bookings!inner ( booking_id, reference_number, status, fleet_return_at )')
    .in(column, ids)
    .eq('bookings.status', 'completed')
    .is('bookings.fleet_return_at', null)

  if (error) throw error

  for (const row of (data ?? []) as any[]) {
    const key = row[column]
    if (!key || byId.has(key)) continue
    byId.set(key, {
      driver_id:        row.driver_id ?? null,
      truck_id:         row.truck_id  ?? null,
      booking_id:       row.bookings.booking_id,
      reference_number: row.bookings.reference_number ?? null,
    })
  }
  return byId
}

/**
 * Bulk form, for the assignable-driver pool: one query for the whole roster
 * rather than one per driver.
 */
export async function unreturnedVehiclesFor(driverIds: string[]) {
  return unreturnedBy('driver_id', driverIds)
}

/** The same question about vehicles, for the truck pool. */
export async function unreturnedTrucksFor(truckIds: string[]) {
  return unreturnedBy('truck_id', truckIds)
}

/** Single-driver form, for the assignment gate. */
export async function awaitingFleetReturn(driverId: string): Promise<UnreturnedVehicle | null> {
  return (await unreturnedBy('driver_id', [driverId])).get(driverId) ?? null
}

/** Single-truck form, for the assignment gate. */
export async function truckAwaitingFleetReturn(truckId: string): Promise<UnreturnedVehicle | null> {
  return (await unreturnedBy('truck_id', [truckId])).get(truckId) ?? null
}

/**
 * When this vehicle last came home from a booking, or null if it never has.
 *
 * The fleet's rule is that a truck earns its clearance for one job: it goes out,
 * it comes back, and it is inspected again before it goes anywhere else. A
 * BLOWBAGETS pass therefore expires the moment the vehicle returns, and this is
 * the timestamp that expires it — an inspection counts only if it was recorded
 * after the vehicle got back.
 *
 * Read from the booking rather than kept on `trucks` so it cannot drift: it is
 * the same `fleet_return_at` the driver stamps, and there is no second copy to
 * fall out of step with the first.
 */
export async function lastFleetReturnsFor(truckIds: string[]): Promise<Map<string, string>> {
  const byTruck = new Map<string, string>()
  if (truckIds.length === 0) return byTruck

  const { data, error } = await supabase
    .from('deliveries')
    .select('truck_id, bookings!inner ( fleet_return_at )')
    .in('truck_id', truckIds)
    .not('bookings.fleet_return_at', 'is', null)

  if (error) throw error

  // Most recent wins: a truck that has run many bookings is only as clear as its
  // latest homecoming.
  for (const row of (data ?? []) as any[]) {
    const at = row.bookings?.fleet_return_at
    if (!row.truck_id || !at) continue
    const seen = byTruck.get(row.truck_id)
    if (!seen || at > seen) byTruck.set(row.truck_id, at)
  }
  return byTruck
}

export async function lastFleetReturnFor(truckId: string): Promise<string | null> {
  return (await lastFleetReturnsFor([truckId])).get(truckId) ?? null
}

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
