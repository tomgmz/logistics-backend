import TripModel from '../../models/client/trip.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { notifyStage } from '../notification/notification.service.js'
import { invalidateEta } from '../maps/eta.service.js'
import { supersedeLateConfirmations } from '../driver/late-confirmation.service.js'
import {
  driverConfirmTripPickupService,
  driverConfirmTripStopService,
  driverConfirmFleetReturnService,
  announceRouteChanged,
  closeTripIfDone,
} from '../client/trip.service.js'
import type { DriverActor } from '../client/booking.service.js'

/**
 * The Company Administrator or Operations Manager moving a delivery on when the
 * driver can't (phone stolen, dead, lost): load a run, finish a drop-off,
 * record the vehicle back. Each goes through the driver's own service with an
 * office actor, so the order rules (run 1 before run 2, pickup before drop-off,
 * load transfer first) are exactly the driver's. No photo or 100 m gate: the
 * office isn't at the stop. A reason is required and kept on the stop.
 *
 * And when something went wrong on the road (truck or goods stolen, accident,
 * goods damaged), the office records the drop-offs as failed with what
 * happened. A failed drop-off counts as done for the run, so the delivery can
 * still be closed; the client and the office are told.
 */

function officeActor(userId: string | null | undefined, role: string | null | undefined, reason: string): DriverActor {
  return { userId, role, office: { reason: reason.trim() } }
}

async function tripOnBooking(bookingId: string, tripId: string) {
  const trip = await TripModel.findById(tripId)
  if (!trip || trip.booking_id !== bookingId) throw new Error('Trip not found on this booking')
  return trip
}

async function stopOnBooking(bookingId: string, tripStopId: string) {
  const stop = await TripModel.findStopById(tripStopId)
  if (!stop || stop.booking_trips.booking_id !== bookingId) throw new Error('Drop-off not found on this booking')
  return stop
}

export async function officeConfirmPickupService(
  bookingId: string, tripId: string, reason: string, userId?: string | null, role?: string | null,
) {
  await tripOnBooking(bookingId, tripId)
  // Not before the driver has started (user 2026-11-13): an office load on an
  // Assigned booking would start the delivery without the driver. Before Start
  // the office re-assigns instead.
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  if (booking.status !== 'in_transit') {
    throw new Error(
      `Cannot confirm a step for the driver on a booking that is '${booking.status}'. ` +
      `The driver starts the delivery with Start Navigation; before that, assign another driver if needed`,
    )
  }
  // An office load is never "early" by accident: the office chose to do it now.
  return driverConfirmTripPickupService(tripId, '', officeActor(userId, role, reason), true, null)
}

export async function officeConfirmStopService(
  bookingId: string, tripStopId: string, reason: string, userId?: string | null, role?: string | null,
) {
  await stopOnBooking(bookingId, tripStopId)
  return driverConfirmTripStopService(tripStopId, '', officeActor(userId, role, reason), null)
}

export async function officeConfirmFleetReturnService(
  bookingId: string, reason: string, userId?: string | null, role?: string | null,
) {
  return driverConfirmFleetReturnService(bookingId, officeActor(userId, role, reason), null)
}

export const INCIDENT_TYPES = {
  truck_stolen:   'Truck stolen',
  goods_stolen:   'Goods stolen',
  accident:       'Accident',
  goods_damaged:  'Goods damaged',
  client_refused: 'Client refused the delivery',
  other:          'Other',
} as const
export type IncidentType = keyof typeof INCIDENT_TYPES

/**
 * Marks the chosen drop-offs failed (every one still open when none are named).
 * Only on a delivery in transit, and only stops not yet delivered.
 */
export async function officeReportIncidentService(
  bookingId: string,
  input: { incident_type: IncidentType; note: string; trip_stop_ids?: string[] | null },
  userId?: string | null,
  role?: string | null,
) {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  if (booking.status !== 'in_transit') {
    throw new Error(`Cannot report an incident on a booking that is '${booking.status}'`)
  }

  const trips = await TripModel.findByBookingId(bookingId)
  const open  = trips.flatMap((t) => t.booking_trip_stops
    .filter((s) => s.status === 'pending')
    .map((s) => ({ ...s, trip: t })))
  const chosen = input.trip_stop_ids?.length
    ? open.filter((s) => input.trip_stop_ids!.includes(s.trip_stop_id))
    : open
  if (chosen.length === 0) throw new Error('Cannot report an incident: no open drop-off to mark as failed')

  const label  = INCIDENT_TYPES[input.incident_type]
  const reason = `${label}: ${input.note.trim()}`
  const actor  = officeActor(userId, role, reason)
  const fence  = { distance_m: null, override_reason: `Failed — reported by the office: ${reason}` }

  for (const s of chosen) {
    await TripModel.setStopProof(s.trip_stop_id, 'failed', null, null, fence, null)
    await supersedeLateConfirmations({ tripStopId: s.trip_stop_id })
    // The bay is failed once nothing else is still bound for it.
    const siblings = await TripModel.findStopsByDestinationId(s.destination_id)
    if (!siblings.some((x) => x.status === 'pending')) {
      const anyDelivered = siblings.some((x) => x.status === 'delivered')
      if (!anyDelivered) await BookingModel.updateDestinationStatus(s.destination_id, 'failed', null, null, fence as any)
    }
  }
  for (const t of new Set(chosen.map((s) => s.trip.trip_id))) {
    await closeTripIfDone(t, bookingId, actor)
  }

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'office_incident_reported',
    description: `Incident on booking ${bookingRef(booking)} — ${reason}. ${chosen.length} drop-off(s) marked failed`,
  })
  void notifyStage('delivery_incident', booking, { reason: label })
  void notifyStage('delivery_incident_staff', booking, { reason })

  void invalidateEta(bookingId).catch(() => {})
  announceRouteChanged(bookingId)
  return BookingModel.findById(bookingId)
}
