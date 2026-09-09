import TripModel from '../../models/client/trip.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { isBeforeScheduledDay } from '../../lib/ph-date.js'
import { invalidateEta } from '../maps/eta.service.js'
import {
  assertStopProximity,
  stopCoordinates,
  type StopProofPosition,
} from '../../lib/stop-geofence.js'
import {
  assertDriverOnBooking,
  driverCompleteBookingService,
  type DriverActor,
} from './booking.service.js'
import type { TripPlanInput, TripWithStops } from '../../types/client/trip.types.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'

/**
 * Driver progress across a MULTI-TRIP booking.
 *
 * The old flow assumed one truckload: confirm the pickup once, work down the
 * drop-offs, done. When the cargo is bigger than the body the same truck runs
 * the route several times, so "confirm the pickup" happens once per run and the
 * drop-offs belong to runs rather than to the booking directly.
 *
 * The order the server enforces is therefore:
 *
 *   trip 1 pickup → trip 1's stops → trip 2 pickup → trip 2's stops → … → done
 *                                                                     → fleet return
 *
 * A trip cannot be loaded while an earlier one is still out, and a stop cannot
 * be confirmed on a trip that has not been loaded. Everything here is idempotent
 * — the mobile offline queue retries, sometimes hours later — so re-sending a
 * confirmation returns the current record rather than failing.
 */

/* ── Reading the plan ─────────────────────────────────────────────────────── */

/**
 * Staff who plan and supervise deliveries rather than drive them.
 *
 * They reach the plan through the admin routes, which are already role-gated, so
 * the per-booking check below would be a second gate asking the wrong question:
 * `assertDriverOnBooking` answers "is this the driver on this job", and for an
 * operations manager the answer is always no.
 */
const SUPERVISOR_ROLES = ['admin', 'it_admin', 'operations_manager', 'general_manager', 'fleet_manager']

/**
 * Whoever is asking may see this booking's plan.
 *
 * Two different questions depending on who is asking. A driver may see only the
 * booking they are actually crewed on — that is `assertDriverOnBooking`, and it
 * is what stops one driver reading another's job. Supervisory staff may see any
 * booking, because planning the runs is their job and they do it before any
 * driver has touched it.
 */
async function assertCanReadTrips(bookingId: string, actor: DriverActor) {
  if (actor.role && SUPERVISOR_ROLES.includes(actor.role)) {
    const booking = await BookingModel.findById(bookingId)
    if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
    return booking
  }
  return assertDriverOnBooking(bookingId, actor)
}

/**
 * The booking's trips, for whoever is allowed to see them.
 *
 * `ensurePlan` runs here rather than at booking creation so bookings taken
 * before trips existed — and any whose plan operations never set — still open in
 * the driver app, as a single run over every drop-off. That is exactly the
 * behaviour those bookings had before, so nothing changes for them.
 */
export async function getTripsService(
  bookingId: string,
  actor: DriverActor,
): Promise<TripWithStops[]> {
  await assertCanReadTrips(bookingId, actor)
  return TripModel.ensurePlan(bookingId)
}

/* ── Planning ─────────────────────────────────────────────────────────────── */

/**
 * Operations sets how many runs the truck makes and which bays each serves.
 *
 * Validated against the booking's own drop-offs: a plan that names a bay
 * belonging to another booking, or that leaves a bay unserved, is a plan the
 * driver cannot complete — the booking would sit in transit forever with a stop
 * nobody was ever sent to.
 */
export async function setTripPlanService(
  bookingId: string,
  plan: TripPlanInput[],
  actor: DriverActor,
): Promise<TripWithStops[]> {
  // Defence in depth. The route is staff-gated, but this service takes a booking
  // id and nothing else, and re-planning is the one write here that touches a
  // booking the caller has no other relationship to — so it states its own
  // audience rather than trusting whichever route reaches it next.
  if (!actor.role || !SUPERVISOR_ROLES.includes(actor.role)) {
    throw new Error('You are not allowed to plan trips on this booking')
  }

  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  if (plan.length === 0) throw new Error('A booking needs at least one trip')

  const destinations = await BookingModel.findDestinationsByBookingId(bookingId) ?? []
  const valid        = new Set(destinations.map((d) => d.destination_id))

  const named = new Set<string>()
  for (const trip of plan) {
    if (trip.destination_ids.length === 0) {
      throw new Error('Every trip must serve at least one drop-off')
    }
    for (const id of trip.destination_ids) {
      if (!valid.has(id)) {
        throw new Error(`Drop-off ${id} is not on this booking`)
      }
      named.add(id)
    }
  }

  // A bay served by two trips is the whole point (a load too big for one run),
  // so duplicates across trips are fine. A bay served by NO trip is not.
  const unserved = destinations.filter((d) => !named.has(d.destination_id))
  if (unserved.length > 0) {
    throw new Error(
      `${unserved.length} drop-off(s) are not on any trip — every drop-off must be served: ` +
      unserved.map((d) => d.address).join('; '),
    )
  }

  const trips = await TripModel.replacePlan(bookingId, plan)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'booking_trips_planned',
    description:
      `Booking ${bookingRef(booking)} planned as ${trips.length} trip(s) of the assigned vehicle ` +
      `(${trips.map((t) => `#${t.trip_number}: ${t.booking_trip_stops.length} stop(s)`).join(', ')})`,
  })

  return trips
}

/* ── Loading a run ────────────────────────────────────────────────────────── */

/**
 * The driver confirms the truck is loaded for one run, with the photo taken at
 * the origin. The first such confirmation is what puts the booking `in_transit`.
 *
 * `earlyStart` carries the driver's decision to run a booking ahead of its
 * scheduled day, and is only consulted on the FIRST trip — once a booking has
 * legitimately started, reloading for run two is not a second early start.
 */
export async function driverConfirmTripPickupService(
  tripId: string,
  proofPhotoUrl: string,
  actor: DriverActor,
  earlyStart = false,
  position?: StopProofPosition | null,
): Promise<TripWithStops> {
  const trip = await TripModel.findById(tripId)
  if (!trip) throw new Error(`Trip with ID ${tripId} not found`)

  const booking = await assertDriverOnBooking(trip.booking_id, actor)

  // Already loaded, or already run and back. Either way there is nothing to do
  // and the queue is retrying — hand back what stands.
  if (trip.status === 'in_transit' || trip.status === 'completed') return trip
  if (trip.status === 'cancelled') {
    throw new Error(`Trip ${trip.trip_number} was cancelled and cannot be loaded`)
  }
  if (booking.status !== 'assigned' && booking.status !== 'in_transit') {
    throw new Error(`Cannot load a trip while the booking is '${booking.status}'`)
  }
  if (!proofPhotoUrl) {
    throw new Error('A proof-of-loading photo is required to confirm this pickup')
  }

  // One truck, one load at a time. Loading run 3 while run 2 is still out would
  // mean the vehicle is in two places, and the resulting proof trail could not
  // be read back in any order that made sense.
  const trips     = await TripModel.findByBookingId(trip.booking_id)
  const blocking  = trips.find(
    (t) => t.trip_number < trip.trip_number &&
           t.status !== 'completed' && t.status !== 'cancelled',
  )
  if (blocking) {
    throw new Error(
      `Finish trip ${blocking.trip_number} before loading trip ${trip.trip_number} — ` +
      `the same vehicle runs them one after another`,
    )
  }

  // Only the first run can be "early": that is the one that starts the job.
  const isFirstRun = !trips.some((t) => t.status === 'completed' || t.status === 'in_transit')
  const early      = isFirstRun && isBeforeScheduledDay(booking.schedule_date)
  if (early && !earlyStart) {
    throw new Error(
      `Cannot confirm pickup before the scheduled day — this booking is scheduled for ${booking.schedule_date}.`,
    )
  }

  const fence = assertStopProximity(
    stopCoordinates((booking as any).origin_latitude, (booking as any).origin_longitude),
    position,
    'pickup point',
  )

  await TripModel.setTripPickupProof(tripId, proofPhotoUrl, position, fence)

  // The booking-level pickup columns are what the web app, the client's booking
  // detail and the billing PDFs read. They keep meaning "the first loading",
  // so they are stamped once, by the first run, and left alone after that.
  if (isFirstRun) {
    await BookingModel.setPickupProof(trip.booking_id, proofPhotoUrl, position, fence)
    if (booking.status === 'assigned') {
      await BookingModel.updateStatus(trip.booking_id, 'in_transit')
      await BookingModel.settleDelivery(trip.booking_id, 'in_transit')
    }
  }

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      early ? 'driver_trip_pickup_confirmed_early' : 'driver_trip_pickup_confirmed',
    description:
      `Driver loaded trip ${trip.trip_number} of ${trips.length} for booking ${bookingRef(booking)}` +
      (early ? ` EARLY — scheduled for ${booking.schedule_date}` : ''),
  })

  if (fence.override_reason) {
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      'driver_trip_pickup_confirmed_off_site',
      description:
        `Driver confirmed loading of trip ${trip.trip_number} for booking ${bookingRef(booking)} ` +
        `about ${fence.distance_m} m from the origin — reason given: ${fence.override_reason}`,
    })
  }

  return (await TripModel.findById(tripId))!
}

/* ── Unloading at a stop ──────────────────────────────────────────────────── */

/**
 * One drop-off on one run, confirmed with the photo taken at the bay.
 *
 * Three things roll up from here, in order: the trip stop itself, the DROP-OFF
 * (delivered once no run still owes it a load), and the TRIP (completed once no
 * stop on it is outstanding). Completing the last trip completes the booking.
 */
export async function driverConfirmTripStopService(
  tripStopId: string,
  proofPhotoUrl: string,
  actor: DriverActor,
  position?: StopProofPosition | null,
) {
  const stop = await TripModel.findStopById(tripStopId)
  if (!stop) throw new Error(`Trip stop with ID ${tripStopId} not found`)

  const trip    = stop.booking_trips
  const booking = await assertDriverOnBooking(trip.booking_id, actor)

  if (stop.status === 'delivered') return stop
  if (trip.status !== 'in_transit' && trip.status !== 'completed') {
    throw new Error(`Confirm the pickup for trip ${trip.trip_number} before unloading at this drop-off`)
  }
  if (!proofPhotoUrl) {
    throw new Error('A proof-of-delivery photo is required to confirm this drop-off')
  }

  const destinations = await BookingModel.findDestinationsByBookingId(trip.booking_id) ?? []
  const destination  = destinations.find((d) => d.destination_id === stop.destination_id)
  if (!destination) throw new Error('This drop-off is no longer on the booking')

  const fence = assertStopProximity(
    stopCoordinates(destination.latitude, destination.longitude),
    position,
    'drop-off',
  )

  const updated = await TripModel.setStopProof(tripStopId, 'delivered', proofPhotoUrl, position, fence)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_trip_stop_confirmed',
    description:
      `Driver unloaded at ${destination.address} on trip ${trip.trip_number} ` +
      `of booking ${bookingRef(booking)}`,
  })

  if (fence.override_reason) {
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      'driver_trip_stop_confirmed_off_site',
      description:
        `Driver confirmed a drop-off on trip ${trip.trip_number} of booking ${bookingRef(booking)} ` +
        `about ${fence.distance_m} m away — reason given: ${fence.override_reason}`,
    })
  }

  // A bay is finished only when EVERY run bound for it has unloaded. On a load
  // that splits across two trips, confirming the first must not tell the client
  // their goods have all arrived.
  await rollUpDestination(stop.destination_id, proofPhotoUrl, position, fence)

  await completeTripIfAllStopsDone(trip.trip_id, trip.booking_id, actor)

  // The remaining route just lost a stop, so every cached arrival time after it
  // is wrong by however long the driver spent at this bay. Fire-and-forget: a
  // stale ETA is not worth failing a confirmed delivery over.
  void invalidateEta(trip.booking_id).catch(() => {})

  return updated
}

/**
 * Mark the drop-off delivered once no trip still owes it a load.
 *
 * `booking_destinations` stays the authoritative "is this bay done" for the
 * client, the web app and every existing query; it is now derived from the trip
 * stops rather than written directly. The proof from the run that closed it is
 * copied up, so readers that show one photo per bay still find one.
 */
async function rollUpDestination(
  destinationId: string,
  proofPhotoUrl: string,
  position?: StopProofPosition | null,
  fence?: { distance_m: number | null; override_reason: string | null } | null,
): Promise<void> {
  const siblings    = await TripModel.findStopsByDestinationId(destinationId)
  const outstanding = siblings.filter((s) => s.status !== 'delivered' && s.status !== 'failed')
  if (outstanding.length > 0) return

  await BookingModel.updateDestinationStatus(
    destinationId, 'delivered', proofPhotoUrl, position, fence as any,
  )
}

/**
 * Close the run when nothing on it is outstanding, and the booking when no run
 * is.
 *
 * Best effort and deliberately silent when there is more to do: it runs on every
 * stop confirmation and only the last one finishes anything. A failure here must
 * not fail the driver's confirmation — the stop is already recorded, and the
 * explicit completion endpoint still exists.
 */
async function completeTripIfAllStopsDone(
  tripId: string,
  bookingId: string,
  actor: DriverActor,
): Promise<void> {
  try {
    const trip = await TripModel.findById(tripId)
    if (!trip) return

    const outstanding = trip.booking_trip_stops
      .filter((s) => s.status !== 'delivered' && s.status !== 'failed')
    if (outstanding.length > 0) return

    if (trip.status !== 'completed') {
      await TripModel.updateTripStatus(tripId, 'completed')
      logEvent({
        user_id:     actor.userId,
        log_type:    'booking',
        action:      'driver_trip_completed',
        description: `Trip ${trip.trip_number} of booking ${bookingId} completed; vehicle heading back to the pickup point`,
      })
    }

    const trips     = await TripModel.findByBookingId(bookingId)
    const remaining = trips.filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
    if (remaining.length > 0) return

    // Every run is back. The driver used to have to tap "mark delivery as done"
    // as a separate step; confirming the final stop of the final run IS
    // finishing the delivery, so it says so.
    await driverCompleteBookingService(bookingId, actor)
  } catch (err) {
    console.error('[trips] could not close trip/booking', tripId, err)
  }
}

/* ── Evidence that arrives late ───────────────────────────────────────────── */

/**
 * Attach a proof photo to a stop the driver already confirmed.
 *
 * The confirmation happens at the bay, which is the only place it means
 * anything. The PHOTO does not always make it out of there: a dead zone, an
 * upload that died at 90%, a phone out of storage at the tailgate. Without this
 * the delivery stays permanently unevidenced, because a confirmed stop is
 * idempotent by design and re-sending the confirmation is a no-op.
 *
 * So the driver can come back into the assignment — mid-delivery once signal
 * returns, or after the whole booking is done — and supply what is missing.
 *
 * Two things it deliberately does NOT do:
 *   * it never overwrites a photo that is already there, so a later upload
 *     cannot quietly replace the picture taken at the stop, and
 *   * it never touches the position or distance recorded at the stop. A photo
 *     taken in the yard that evening must not rewrite where the driver stood,
 *     which is the one fact the geofence exists to preserve.
 */
export async function attachStopProofService(
  tripStopId: string,
  proofPhotoUrl: string,
  actor: DriverActor,
) {
  if (!proofPhotoUrl) throw new Error('A proof photo is required')

  const stop = await TripModel.findStopById(tripStopId)
  if (!stop) throw new Error(`Trip stop with ID ${tripStopId} not found`)

  const booking = await assertDriverOnBooking(stop.booking_trips.booking_id, actor)

  if (stop.status === 'pending') {
    throw new Error('Confirm the drop-off before attaching its proof')
  }
  // Already evidenced. Returning it rather than failing keeps the offline queue
  // happy: a retry of an upload that actually landed is not an error.
  if (stop.proof_photo_url) return stop

  const updated = await TripModel.attachStopProof(tripStopId, proofPhotoUrl)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_stop_proof_attached',
    description:
      `Driver supplied a proof photo for a drop-off on booking ${bookingRef(booking)} ` +
      `after the fact — the stop was confirmed without one`,
  })

  return updated
}

/* ── Back at the yard ─────────────────────────────────────────────────────── */

/**
 * The driver confirms the vehicle is back in the company parking lot.
 *
 * The last box coming off the truck is not the end of the job — the vehicle
 * still has to come home, and until it does the fleet does not really have it
 * back. Confirmed once, after the booking is completed; the returns BETWEEN
 * runs are evidenced by the next run's loading photo and are not separately
 * confirmed.
 */
export async function driverConfirmFleetReturnService(
  bookingId: string,
  actor: DriverActor,
  position?: StopProofPosition | null,
): Promise<BookingWithRelations> {
  const booking = await assertDriverOnBooking(bookingId, actor)

  if ((booking as any).fleet_return_at) return booking
  if (booking.status !== 'completed') {
    throw new Error('Confirm every drop-off before recording the return to the yard')
  }

  await TripModel.setFleetReturn(bookingId, position)

  logEvent({
    user_id:     actor.userId,
    log_type:    'vehicle_activity',
    action:      'driver_fleet_return_confirmed',
    description: `Driver confirmed the vehicle for booking ${bookingRef(booking)} is back in the company parking lot`,
  })

  const updated = await BookingModel.findById(bookingId)
  return updated ?? booking
}
