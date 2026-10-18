import { supabase } from '../../lib/supabase.js'
import { withBookingRowLock } from '../../lib/booking-row-lock.js'
import { logEvent } from '../../lib/log-event.js'
import { phDay } from '../../lib/ph-date.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { busyDriversFor, driverBusyMessage } from '../../lib/driver-reservation.js'
import { assertStopProximity, stopCoordinates, type StopProofPosition } from '../../lib/stop-geofence.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from '../notification/notification.service.js'
import { refreshPlannedEta } from '../maps/planned-eta.service.js'
import { invalidateEta } from '../maps/eta.service.js'
import { getRouteDistance } from '../maps/route-distance.service.js'
import { endPauseOnProgress } from '../client/pause.service.js'
import { assertLeadDriverOnBooking, type DriverActor } from '../client/booking.service.js'
import { driverIdOf, pendingLoadTransfer } from '../driver/crew-actor.js'
import {
  assertDriverAssignable,
  assertTruckAssignable,
  crewOnBooking,
  releaseCrew,
  reserveCrew,
} from './fleet-availability.service.js'

/**
 * Replacing the crew of a delivery that is on the road.
 *
 * Re-assigning is refused once the driver has started (assignment.model): it
 * would wipe who did the pickup and push a loaded truck back to 'assigned'. When
 * something goes wrong out there — the truck breaks down, the driver falls ill,
 * the road is shut for the day — the driver pauses the delivery, and the office
 * replaces the driver, the vehicle or both from here. The booking stays
 * 'in_transit' and keeps every trip, stop and proof; the first crew stays on the
 * record in crew_replacements and in who confirmed each stop. The new crew picks
 * up the remaining stops where the first one stopped.
 */

export interface ReplaceCrewInput {
  driver_id:         string
  truck_id:          string
  second_driver_id?: string | null
  helper_name?:      string | null
  reason_note:       string
}

interface StaffActor {
  userId: string | null
  role:   string | null
}

/** Plate + model of a truck, for notification copy. */
async function truckLabel(truckId: string | null): Promise<string | null> {
  if (!truckId) return null
  const { data } = await supabase
    .from('trucks')
    .select('plate_number, truck_models ( name )')
    .eq('truck_id', truckId)
    .maybeSingle()
  if (!data) return null
  const name = (data as any).truck_models?.name
  return name ? `${data.plate_number} · ${name}` : String(data.plate_number)
}

async function userIdsOfDrivers(driverIds: string[]): Promise<string[]> {
  if (driverIds.length === 0) return []
  const { data } = await supabase.from('drivers').select('user_id').in('driver_id', driverIds)
  return (data ?? []).map((r: { user_id: string }) => r.user_id).filter(Boolean)
}

export async function replaceCrewService(
  bookingId: string,
  input: ReplaceCrewInput,
  staff: StaffActor,
) {
  const note = input.reason_note?.trim() ?? ''
  if (note.length < 3) throw new Error('Say why the crew is being replaced')
  if (!input.driver_id) throw new Error('driver_id is required')
  if (!input.truck_id)  throw new Error('truck_id is required')

  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  if (booking.status !== 'in_transit') {
    throw new Error('Cannot replace the crew: only a delivery that has started can be replaced. Use Change vehicle and driver instead.')
  }

  const previous  = await crewOnBooking(bookingId)
  const { data: prevDelivery } = await supabase
    .from('deliveries')
    .select('is_vendor_supplied, vendor_vehicle_plate')
    .eq('booking_id', bookingId)
    .maybeSingle()

  const second = input.second_driver_id ?? null
  if (second && second === input.driver_id) {
    throw new Error('The second driver must be a different person from the main driver')
  }

  const driverChanged = input.driver_id !== previous.driver_id
  const truckChanged  = input.truck_id  !== previous.truck_id || !!prevDelivery?.is_vendor_supplied
  const secondChanged = (second ?? null) !== (previous.second_driver_id ?? null)
  if (!driverChanged && !truckChanged && !secondChanged) {
    throw new Error('Choose a different driver or vehicle to replace the current one')
  }

  // The same distance rule as assigning: over the threshold a second driver.
  const route = await getRouteDistance(bookingId)
  if (route.requires_second_driver === true && !second) {
    throw new Error(`This route is ${route.distance_km} km. A route over ${route.threshold_km} km needs a second driver.`)
  }
  if (route.requires_second_driver === false && second) {
    throw new Error(`This route is ${route.distance_km} km. A second driver is only for routes over ${route.threshold_km} km — add a helper instead.`)
  }

  // Held to the same pools as an assignment, but for TODAY: the replacement goes
  // out now, whatever day the booking was scheduled for.
  const today   = phDay()
  const onCrew  = (id: string) => id === previous.driver_id || id === previous.second_driver_id ? id : null
  await Promise.all([
    assertDriverAssignable(input.driver_id, onCrew(input.driver_id), today),
    second ? assertDriverAssignable(second, onCrew(second), today) : Promise.resolve(),
    assertTruckAssignable(input.truck_id, prevDelivery?.is_vendor_supplied ? null : previous.truck_id),
  ])
  const crewIds = [input.driver_id, second].filter((x): x is string => !!x)
  const busy = await busyDriversFor(crewIds, bookingId)
  for (const id of crewIds) {
    const b = busy.get(id)
    if (b) throw new Error(driverBusyMessage(id === input.driver_id ? 'This driver' : 'The second driver', b))
  }

  const truckType = (await supabase
    .from('trucks').select('truck_models ( name )').eq('truck_id', input.truck_id).maybeSingle()
  ).data as { truck_models?: { name?: string | null } | null } | null

  const now = new Date().toISOString()
  const replacement = await withBookingRowLock(bookingId, async (client, locked) => {
    if (locked.status !== 'in_transit') {
      throw new Error(`Cannot replace the crew of a booking that is '${locked.status}'`)
    }
    const { rows: [pause] } = await client.query<{
      pause_id: string; trip_id: string | null; report_id: string | null; latitude: string | null; longitude: string | null
    }>(
      `SELECT pause_id, trip_id, report_id, latitude, longitude
         FROM booking_pauses WHERE booking_id = $1 AND resumed_at IS NULL LIMIT 1`,
      [bookingId],
    )
    if (!pause) {
      throw new Error('Cannot replace the crew while the delivery is moving. The driver has to pause it first (for example for a breakdown).')
    }

    // The run whose load is on the old vehicle right now, if any.
    const { rows: [loaded] } = await client.query<{ trip_id: string }>(
      `SELECT trip_id FROM booking_trips WHERE booking_id = $1 AND status = 'in_transit' LIMIT 1`,
      [bookingId],
    )
    const { rows: [lastPing] } = await client.query<{ latitude: string; longitude: string }>(
      `SELECT latitude, longitude FROM driver_locations WHERE driver_id = $1`,
      [previous.driver_id],
    )
    const handoverLat = pause.latitude  ?? lastPing?.latitude  ?? null
    const handoverLng = pause.longitude ?? lastPing?.longitude ?? null

    await client.query(
      `UPDATE deliveries
          SET driver_id = $2, truck_id = $3, second_driver_id = $4, helper_name = $5,
              is_vendor_supplied = false, vendor_name = NULL, vendor_contact = NULL,
              vendor_driver_name = NULL, vendor_driver_license = NULL, vendor_driver_phone = NULL,
              vendor_vehicle_plate = NULL, vendor_vehicle_type = NULL, vendor_driver_email = NULL,
              vendor_driver_user_id = NULL, updated_at = $6
        WHERE booking_id = $1`,
      [bookingId, input.driver_id, input.truck_id, second, second ? null : input.helper_name?.trim() || null, now],
    )
    await client.query('DELETE FROM driver_assignments WHERE booking_id = $1', [bookingId])
    await client.query('DELETE FROM truck_assignments  WHERE booking_id = $1', [bookingId])
    await client.query(
      `INSERT INTO driver_assignments (booking_id, driver_id, crew_role, assigned_at, assigned_by)
       VALUES ($1, $2, 'lead', $3, $4)`,
      [bookingId, input.driver_id, now, staff.userId],
    )
    if (second) {
      await client.query(
        `INSERT INTO driver_assignments (booking_id, driver_id, crew_role, assigned_at, assigned_by)
         VALUES ($1, $2, 'second', $3, $4)`,
        [bookingId, second, now, staff.userId],
      )
    }
    await client.query(
      `INSERT INTO truck_assignments (booking_id, truck_id, assigned_at, assigned_by) VALUES ($1, $2, $3, $4)`,
      [bookingId, input.truck_id, now, staff.userId],
    )
    await client.query(
      `UPDATE bookings SET truck_type_needed = COALESCE($2, truck_type_needed), updated_at = $3 WHERE booking_id = $1`,
      [bookingId, truckType?.truck_models?.name ?? null, now],
    )

    const { rows: [row] } = await client.query(
      `INSERT INTO crew_replacements (
         booking_id, trip_id, pause_id, report_id,
         old_driver_id, old_second_driver_id, old_truck_id, old_vehicle_plate,
         new_driver_id, new_second_driver_id, new_truck_id,
         reason_note, handover_latitude, handover_longitude, transfer_required,
         replaced_by, replaced_by_role, replaced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        bookingId, loaded?.trip_id ?? pause.trip_id, pause.pause_id, pause.report_id,
        previous.driver_id, previous.second_driver_id, prevDelivery?.is_vendor_supplied ? null : previous.truck_id,
        prevDelivery?.is_vendor_supplied ? prevDelivery.vendor_vehicle_plate : null,
        input.driver_id, second, input.truck_id,
        note, handoverLat, handoverLng,
        // The load moves only if there is one aboard and the vehicle changed.
        !!loaded && truckChanged,
        staff.userId, staff.role, now,
      ],
    )
    return row as Record<string, any>
  })

  // ── After commit: fleet state, record, notices ────────────────────────────
  const staying = new Set(crewIds)
  const offIds  = [previous.driver_id, previous.second_driver_id]
    .filter((id): id is string => !!id && !staying.has(id))
  // Drivers taken off are free again. The old VEHICLE is not released: it is
  // standing wherever it stopped, possibly broken down, and only the Fleet
  // Manager can say when it is fit for work — they are told below.
  await releaseCrew(
    previous.driver_id && !staying.has(previous.driver_id) ? previous.driver_id : null,
    null,
    previous.second_driver_id && !staying.has(previous.second_driver_id) ? previous.second_driver_id : null,
  )
  await reserveCrew(input.driver_id, input.truck_id, second)

  const after = (await BookingModel.findById(bookingId)) ?? booking
  const swapped =
    driverChanged && truckChanged ? 'driver and vehicle'
    : truckChanged ? 'vehicle'
    : 'driver'
  const oldVehicle = (await truckLabel(replacement.old_truck_id)) ?? replacement.old_vehicle_plate ?? 'the old vehicle'

  logEvent({
    user_id:     staff.userId,
    log_type:    'booking',
    action:      'booking_crew_replaced',
    description:
      `Booking ${bookingRef(after)}: ${swapped} replaced on the road — driver ${previous.driver_id ?? 'none'} → ${input.driver_id}, ` +
      `vehicle ${replacement.old_truck_id ?? replacement.old_vehicle_plate ?? 'none'} → ${input.truck_id}` +
      `${replacement.transfer_required ? '; load transfer required' : ''}. Reason: ${note}`,
  })

  const offUserIds = await userIdsOfDrivers(offIds)
  if (offUserIds.length) void notifyStage('crew_replaced_off', after, { onlyUserIds: offUserIds, reason: note, swapped })
  void notifyStage('crew_replaced_on', after, { transfer: replacement.transfer_required, vehicleLabel: oldVehicle })
  void notifyStage('crew_replaced_client', after, { swapped })
  if (truckChanged && replacement.old_truck_id) {
    void notifyStage('crew_replaced_fleet', after, { vehicleLabel: oldVehicle, reason: note })
  }

  // The truck on the map and its arrival times are now the new crew's.
  void invalidateEta(bookingId).catch(() => {})
  void refreshPlannedEta(bookingId)

  return replacement
}

/** Every replacement on a booking, oldest first, with names and plates for the web. */
export async function listCrewReplacementsService(bookingId: string) {
  const person = 'driver_id, users ( first_name, last_name )'
  const { data, error } = await supabase
    .from('crew_replacements')
    .select(`
      *,
      old_driver:drivers!crew_replacements_old_driver_id_fkey ( ${person} ),
      new_driver:drivers!crew_replacements_new_driver_id_fkey ( ${person} ),
      old_second_driver:drivers!crew_replacements_old_second_driver_id_fkey ( ${person} ),
      new_second_driver:drivers!crew_replacements_new_second_driver_id_fkey ( ${person} ),
      old_truck:trucks!crew_replacements_old_truck_id_fkey ( plate_number ),
      new_truck:trucks!crew_replacements_new_truck_id_fkey ( plate_number ),
      replaced_by_user:users!crew_replacements_replaced_by_fkey ( first_name, last_name )
    `)
    .eq('booking_id', bookingId)
    .order('replaced_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

/** What the new driver's phone needs to show the transfer step, or null. */
export async function driverPendingLoadTransferService(bookingId: string, actor: DriverActor) {
  await assertLeadDriverOnBooking(bookingId, actor)
  const pending = await pendingLoadTransfer(bookingId)
  if (!pending) return null
  return {
    replacement_id:     pending.replacement_id,
    // The run whose load is being moved — the photo is stamped as its loading.
    trip_id:            pending.trip_id,
    old_vehicle_plate:  (pending as any).old_truck?.plate_number ?? pending.old_vehicle_plate ?? null,
    handover_latitude:  pending.handover_latitude  != null ? Number(pending.handover_latitude)  : null,
    handover_longitude: pending.handover_longitude != null ? Number(pending.handover_longitude) : null,
    replaced_at:        pending.replaced_at,
  }
}

/**
 * The new driver moved the load onto their vehicle, with a photo taken there.
 * Drop-offs are refused until this lands (crew-actor.assertNoPendingLoadTransfer).
 * Idempotent: with nothing outstanding it simply returns.
 */
export async function driverConfirmLoadTransferService(
  bookingId: string,
  proofPhotoUrl: string,
  actor: DriverActor,
  position?: StopProofPosition | null,
) {
  await assertLeadDriverOnBooking(bookingId, actor)
  const pending = await pendingLoadTransfer(bookingId)
  if (!pending) return { confirmed: false }
  if (!proofPhotoUrl) throw new Error('Cannot confirm the transfer without a photo of the load on the new vehicle')

  // Measured against where the old vehicle stopped, when that is known — the
  // same distance rule (and stated-reason override) as every other stop.
  const fence = assertStopProximity(
    stopCoordinates(pending.handover_latitude, pending.handover_longitude),
    position,
    'hand-over point',
  )

  const { error } = await supabase
    .from('crew_replacements')
    .update({
      transfer_confirmed_at: new Date().toISOString(),
      transfer_confirmed_by: await driverIdOf(actor),
      transfer_photo_url:    proofPhotoUrl,
      transfer_latitude:     Number.isFinite(position?.latitude)  ? position!.latitude  : null,
      transfer_longitude:    Number.isFinite(position?.longitude) ? position!.longitude : null,
      transfer_accuracy_m:   position?.accuracy_m ?? null,
    })
    .eq('replacement_id', pending.replacement_id)
    .is('transfer_confirmed_at', null)
  if (error) throw error

  // The load is aboard the new truck: it is moving again.
  await endPauseOnProgress(bookingId, actor)

  const booking = await BookingModel.findById(bookingId)
  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_load_transfer_confirmed',
    description:
      `Driver confirmed the load transfer onto the new vehicle for booking ${booking ? bookingRef(booking) : bookingId}` +
      (fence.override_reason ? ` about ${fence.distance_m} m from the hand-over point — reason given: ${fence.override_reason}` : ''),
  })
  void invalidateEta(bookingId).catch(() => {})
  void refreshPlannedEta(bookingId)
  return { confirmed: true }
}
