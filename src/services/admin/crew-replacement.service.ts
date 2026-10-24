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
import { assertLeadDriverOnBooking, type DriverActor } from '../client/booking.service.js'
import { driverIdOf, pendingLoadTransfer } from '../driver/crew-actor.js'
import {
  findExternalDriverForAssignment,
  issueInvite,
  type ExternalDriverForAssignment,
} from '../auth/driver-enrollment.service.js'
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
 *
 * The new crew comes from the 8338 fleet (driver + registered vehicle) or from
 * a vendor (a registered vendor driver + the vendor's typed-in vehicle), the
 * same two paths as an assignment. A helper is a typed name only.
 */

export interface ReplaceCrewInput {
  driver_id?:        string
  truck_id?:         string
  second_driver_id?: string | null
  helper_name?:      string | null
  reason_note:       string
  is_vendor_supplied?:           boolean
  vendor_driver_user_id?:        string
  second_vendor_driver_user_id?: string | null
  vendor_vehicle_plate?:         string
  vendor_vehicle_type?:          string | null
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

  // The vendor path reads its drivers from the registry before anything is
  // written, so a revoked or deleted vendor driver is refused up front.
  const vendor = input.is_vendor_supplied === true
  let external:       ExternalDriverForAssignment | null = null
  let externalSecond: ExternalDriverForAssignment | null = null
  if (vendor) {
    if (!input.vendor_driver_user_id) throw new Error('Choose the vendor driver')
    if (!input.vendor_vehicle_plate?.trim()) throw new Error('Vendor vehicle plate is required')
    if (input.second_vendor_driver_user_id && input.second_vendor_driver_user_id === input.vendor_driver_user_id) {
      throw new Error('The second driver must be a different person from the main driver')
    }
    ;[external, externalSecond] = await Promise.all([
      findExternalDriverForAssignment(input.vendor_driver_user_id),
      input.second_vendor_driver_user_id
        ? findExternalDriverForAssignment(input.second_vendor_driver_user_id)
        : Promise.resolve(null),
    ])
  } else {
    if (!input.driver_id) throw new Error('driver_id is required')
    if (!input.truck_id)  throw new Error('truck_id is required')
  }
  // drivers.driver_id of the new lead driver, on either path.
  const leadId  = vendor ? external!.driverId : input.driver_id!
  const truckId = vendor ? null : input.truck_id!
  const plate   = vendor ? input.vendor_vehicle_plate!.trim().toUpperCase() : null

  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  if (booking.status !== 'in_transit') {
    throw new Error('Cannot replace the crew: only a delivery that has started can be replaced. Use Change vehicle and driver instead.')
  }

  const previous  = await crewOnBooking(bookingId)
  const { data: prevDelivery } = await supabase
    .from('deliveries')
    .select('is_vendor_supplied, vendor_vehicle_plate, vendor_driver_user_id, helper_name')
    .eq('booking_id', bookingId)
    .maybeSingle()

  const second = vendor ? externalSecond?.driverId ?? null : input.second_driver_id ?? null
  if (second && second === leadId) {
    throw new Error('The second driver must be a different person from the main driver')
  }
  // A helper rides only where there is no second driver.
  const helper = second ? null : input.helper_name?.trim() || null

  // A vendor lead is not in deliveries.driver_id, so compare by their account.
  const driverChanged = vendor
    ? input.vendor_driver_user_id !== prevDelivery?.vendor_driver_user_id
    : leadId !== previous.driver_id
  const truckChanged  = vendor
    ? !prevDelivery?.is_vendor_supplied || plate !== prevDelivery?.vendor_vehicle_plate
    : truckId !== previous.truck_id || !!prevDelivery?.is_vendor_supplied
  const secondChanged = (second ?? null) !== (previous.second_driver_id ?? null)
  const helperChanged = helper !== (prevDelivery?.helper_name ?? null)
  if (!driverChanged && !truckChanged && !secondChanged && !helperChanged) {
    throw new Error('Change the driver, vehicle, second driver or helper first')
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
  // Vendor crews are not in the company pools; the busy check below is theirs.
  const onCrew  = (id: string) => id === previous.driver_id || id === previous.second_driver_id ? id : null
  if (!vendor) {
    await Promise.all([
      assertDriverAssignable(leadId, onCrew(leadId), today),
      second ? assertDriverAssignable(second, onCrew(second), today) : Promise.resolve(),
      assertTruckAssignable(truckId!, prevDelivery?.is_vendor_supplied ? null : previous.truck_id),
    ])
  }
  // Nobody already on another active booking, in either seat, on either path.
  const crewIds = [leadId, second].filter((x): x is string => !!x)
  const busy = await busyDriversFor(crewIds, bookingId)
  for (const id of crewIds) {
    const b = busy.get(id)
    if (b) throw new Error(driverBusyMessage(id === leadId ? 'This driver' : 'The second driver', b))
  }

  const truckType = vendor
    ? input.vendor_vehicle_type?.trim() || null
    : ((await supabase
        .from('trucks').select('truck_models ( name )').eq('truck_id', truckId).maybeSingle()
      ).data as { truck_models?: { name?: string | null } | null } | null)?.truck_models?.name ?? null
  const snap = external?.snapshot

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

    // Same shape as an assignment (assignment.model): a vendor crew is a
    // snapshot on the delivery with deliveries.driver_id / truck_id left NULL.
    await client.query(
      `UPDATE deliveries
          SET driver_id = $2, truck_id = $3, second_driver_id = $4, helper_name = $5,
              is_vendor_supplied = $6, vendor_name = $7, vendor_contact = $8,
              vendor_driver_name = $9, vendor_driver_license = $10, vendor_driver_phone = $11,
              vendor_vehicle_plate = $12, vendor_vehicle_type = $13, vendor_driver_email = $14,
              vendor_driver_user_id = $15, updated_at = $16
        WHERE booking_id = $1`,
      [
        bookingId, vendor ? null : leadId, truckId, second, helper,
        vendor, snap?.vendor_name ?? null, snap?.vendor_contact ?? null,
        snap?.vendor_driver_name ?? null, snap?.vendor_driver_license ?? null, snap?.vendor_driver_phone ?? null,
        plate, vendor ? input.vendor_vehicle_type?.trim() || null : null, snap?.vendor_driver_email ?? null,
        external?.userId ?? null, now,
      ],
    )
    await client.query('DELETE FROM driver_assignments WHERE booking_id = $1', [bookingId])
    await client.query('DELETE FROM truck_assignments  WHERE booking_id = $1', [bookingId])
    await client.query(
      `INSERT INTO driver_assignments (booking_id, driver_id, crew_role, assigned_at, assigned_by)
       VALUES ($1, $2, 'lead', $3, $4)`,
      [bookingId, leadId, now, staff.userId],
    )
    if (second) {
      await client.query(
        `INSERT INTO driver_assignments (booking_id, driver_id, crew_role, assigned_at, assigned_by)
         VALUES ($1, $2, 'second', $3, $4)`,
        [bookingId, second, now, staff.userId],
      )
    }
    // A registered fleet row only: there is none for a vendor vehicle.
    if (truckId) {
      await client.query(
        `INSERT INTO truck_assignments (booking_id, truck_id, assigned_at, assigned_by) VALUES ($1, $2, $3, $4)`,
        [bookingId, truckId, now, staff.userId],
      )
    }
    await client.query(
      `UPDATE bookings SET truck_type_needed = COALESCE($2, truck_type_needed), updated_at = $3 WHERE booking_id = $1`,
      [bookingId, truckType, now],
    )

    const { rows: [row] } = await client.query(
      `INSERT INTO crew_replacements (
         booking_id, trip_id, pause_id, report_id,
         old_driver_id, old_second_driver_id, old_truck_id, old_vehicle_plate,
         new_driver_id, new_second_driver_id, new_truck_id, new_vehicle_plate,
         reason_note, handover_latitude, handover_longitude, transfer_required,
         replaced_by, replaced_by_role, replaced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        bookingId, loaded?.trip_id ?? pause.trip_id, pause.pause_id, pause.report_id,
        previous.driver_id, previous.second_driver_id, prevDelivery?.is_vendor_supplied ? null : previous.truck_id,
        prevDelivery?.is_vendor_supplied ? prevDelivery.vendor_vehicle_plate : null,
        leadId, second, truckId, plate,
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
  // The company reservation state machine is fleet-only; a vendor crew is not in it.
  if (!vendor) await reserveCrew(leadId, truckId, second)

  // A vendor driver with no working passkey gets a setup link, as on assigning.
  for (const driver of [external, externalSecond]) {
    if (!driver?.needsInvite) continue
    void issueInvite({
      userId:     driver.userId,
      email:      driver.snapshot.vendor_driver_email,
      bookingId,
      bookingRef: bookingRef(booking),
      firstName:  driver.firstName,
      actorId:    staff.userId,
    }).catch((err) => {
      console.error('[crew-replacement] failed to send vendor driver invite', bookingId, err)
    })
  }

  const after = (await BookingModel.findById(bookingId)) ?? booking
  const swapped =
    driverChanged && truckChanged ? 'driver and vehicle'
    : truckChanged ? 'vehicle'
    : driverChanged || secondChanged ? 'driver'
    : 'helper'
  const oldVehicle = (await truckLabel(replacement.old_truck_id)) ?? replacement.old_vehicle_plate ?? 'the old vehicle'

  logEvent({
    user_id:     staff.userId,
    log_type:    'booking',
    action:      'booking_crew_replaced',
    description:
      `Booking ${bookingRef(after)}: ${swapped} replaced on the road — driver ${previous.driver_id ?? 'none'} → ${leadId}${vendor ? ' (vendor)' : ''}, ` +
      `vehicle ${replacement.old_truck_id ?? replacement.old_vehicle_plate ?? 'none'} → ${truckId ?? plate}` +
      `${helper ? `, helper ${helper}` : ''}` +
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

  // The load is aboard the new truck. The pause stays until the office ends it.

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
