import TripModel from '../../models/client/trip.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { logEvent } from '../../lib/log-event.js'
import * as TruckModel from '../../models/admin/truck.model.js'
import { assertBookingVehicleInService, crewOnBooking } from '../admin/fleet-availability.service.js'
import { notifyStage } from '../notification/notification.service.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { isBeforeScheduledDay } from '../../lib/ph-date.js'
import { invalidateEta } from '../maps/eta.service.js'
import { broadcast } from '../../lib/realtime.js'
import { refreshPlannedEta } from '../maps/planned-eta.service.js'
import { endPauseOnProgress } from './pause.service.js'
import {
  assertStopProximity,
  stopCoordinates,
  type StopProofPosition,
} from '../../lib/stop-geofence.js'
import {
  assertDriverOnBooking,
  assertLeadDriverOnBooking,
  driverCompleteBookingService,
  type DriverActor,
} from './booking.service.js'
import type { CargoQuantity, TripPlanInput, TripWithStops } from '../../types/client/trip.types.js'
import { isStartedTrip } from '../../models/client/trip.model.js'
import {
  CargoLoadError,
  checkPlanQuantities,
  lineTotal,
  rollCargo,
  type CargoLine,
  type PlanTrip,
} from '../../lib/trip-cargo.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'
import { claimDeliveryStart } from '../driver/start-delivery.service.js'
import { assertNoPendingLoadTransfer, driverIdOf } from '../driver/crew-actor.js'

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

  // Loaded and finished runs are kept as they are; the plan covers the rest.
  // Whatever numbers the planner sent, the runs still to come follow on from the
  // last started one, in the order given.
  const existing     = await TripModel.findByBookingId(bookingId)
  const started      = existing.filter(isStartedTrip)
  const startedNums  = new Set(started.map((t) => t.trip_number))
  const firstFree    = started.reduce((n, t) => Math.max(n, t.trip_number), 0) + 1
  plan = plan
    .filter((t) => t.trip_number == null || !startedNums.has(t.trip_number))
    .map((t, i) => ({ ...t, trip_number: firstFree + i }))
  if (plan.length === 0 && started.length === 0) throw new Error('A booking needs at least one trip')
  if (started.length + plan.length > 10) throw new Error('A booking cannot be planned as more than 10 trips')

  const named = new Set<string>(started.flatMap((t) => t.booking_trip_stops.map((s) => s.destination_id)))
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

  // Quantities, when the planner sends them (it always does now; a plan without
  // is the older whole-drop-off one and still accepted).
  if (plan.some((t) => t.stops)) {
    if (!plan.every((t) => t.stops)) throw new Error('Every trip must say how much it carries')
    for (const t of plan) {
      const ids = new Set(t.destination_ids)
      if (t.stops!.length !== ids.size || t.stops!.some((s) => !ids.has(s.destination_id))) {
        throw new Error(`Trip ${t.trip_number}'s quantities must match its drop-offs`)
      }
    }
    const { lines, labels, raw } = await cargoLines(bookingId)
    const problem = checkPlanQuantities(
      toPlanTrips(started),
      plan.map((t) => ({ trip_number: t.trip_number!, stops: t.stops! })),
      lines, labels, raw,
    )
    if (problem) throw new PlanQuantityError(problem)
  }

  const trips = await TripModel.replacePlan(bookingId, plan)
  void refreshPlannedEta(bookingId)

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

/** A planner save whose quantities don't add up — always a 400. */
export class PlanQuantityError extends Error {}

/** The booking's cargo lines as the split rules see them, plus names for messages. */
async function cargoLines(bookingId: string) {
  const items  = await BookingModel.findCargoItemsByBookingId(bookingId) ?? []
  const lines: CargoLine[] = []
  const labels = new Map<string, string>()
  const raw    = new Map<string, number | null>()
  for (const it of items as any[]) {
    if (!it.destination_id) continue
    const q = it.quantity == null ? null : Number(it.quantity)
    lines.push({ item_id: it.item_id, destination_id: it.destination_id, total: lineTotal(q) })
    labels.set(it.item_id, it.products?.name || it.product_text || it.commodities?.name || it.commodity_text || 'A cargo line')
    raw.set(it.item_id, q)
  }
  return { lines, labels, raw }
}

/** The stored trips in the shape trip-cargo works on. */
function toPlanTrips(trips: TripWithStops[]): PlanTrip[] {
  return trips
    .filter((t) => t.status !== 'cancelled')
    .map((t) => ({
      trip_number: t.trip_number,
      started:     isStartedTrip(t),
      stops: t.booking_trip_stops.map((s) => ({
        destination_id: s.destination_id,
        cargo: (s.booking_trip_cargo ?? []).map((c) => ({
          item_id:     c.item_id,
          planned_qty: Number(c.planned_qty),
          loaded_qty:  c.loaded_qty == null ? null : Number(c.loaded_qty),
        })),
      })),
    }))
}

/**
 * The driver loaded something other than the plan for this run: record it and
 * move the difference onto the runs after it. Only for a plan that has
 * quantities for every cargo line — an older whole-drop-off plan has nothing to
 * move. Returns whether anything changed.
 */
async function applyLoadedCargo(
  trip:    TripWithStops,
  trips:   TripWithStops[],
  loaded:  CargoQuantity[] | undefined,
): Promise<boolean> {
  const { lines } = await cargoLines(trip.booking_id)
  const plan      = toPlanTrips(trips)
  const covered   = new Set(plan.flatMap((t) => t.stops.flatMap((s) => s.cargo.map((c) => c.item_id))))
  if (lines.length === 0 || !lines.every((l) => covered.has(l.item_id))) return false

  const valid = new Set(lines.map((l) => l.item_id))
  const map   = new Map<string, number>()
  for (const l of loaded ?? []) {
    if (!valid.has(l.item_id)) throw new CargoLoadError('Cannot load a cargo line that is not on this booking')
    map.set(l.item_id, l.quantity)
  }

  let next: PlanTrip[]
  try {
    next = rollCargo(plan, lines, trip.trip_number, map)
  } catch (err) {
    // The message reads "Cannot load …" so the queue treats it as a 409.
    if (err instanceof CargoLoadError) throw new Error(err.message.startsWith('Cannot ') ? err.message : `Cannot load this trip: ${err.message}`)
    throw err
  }
  if (next.length > 10) throw new Error('Cannot load this little: the rest would need more than 10 trips')

  await TripModel.applyCargoPlan(trip.booking_id, trips, next)
  return true
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
  loaded?: CargoQuantity[],
): Promise<TripWithStops> {
  const trip = await TripModel.findById(tripId)
  if (!trip) throw new Error(`Trip with ID ${tripId} not found`)

  const booking = await assertLeadDriverOnBooking(trip.booking_id, actor)

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
  // The Fleet Manager pulled the vehicle — no new load goes on it, including a
  // later run of a booking already under way.
  await assertBookingVehicleInService(trip.booking_id)

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

  // Settle the crew before anything is written: under the booking row lock this
  // re-checks that the caller is still the main driver (the office may have
  // re-crewed the booking a moment ago) and moves an 'assigned' booking to
  // 'in_transit', after which it can no longer be re-assigned. Usually Start
  // Navigation already did it; a start made offline lands here.
  await claimDeliveryStart(trip.booking_id, actor)

  // What actually went on the truck, and the rest moved to the later runs —
  // before the run is marked loaded, while it is still reshapeable.
  await applyLoadedCargo(trip, trips, loaded)

  await TripModel.setTripPickupProof(tripId, proofPhotoUrl, position, fence, await driverIdOf(actor))
  // Loading a run means the truck is moving again, whatever the driver forgot.
  await endPauseOnProgress(trip.booking_id, actor)

  // The booking-level pickup columns are what the web app and the client's
  // booking detail read. They keep meaning "the first loading",
  // so they are stamped once, by the first run, and left alone after that.
  if (isFirstRun) {
    await BookingModel.setPickupProof(trip.booking_id, proofPhotoUrl, position, fence)
  }

  // The run's real departure replaces its planned one, and moves every run after it.
  void refreshPlannedEta(trip.booking_id)
  announceRouteChanged(trip.booking_id)

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

/**
 * Tell anyone watching the booking (web Transit Tracking, client tracking, on route:booking:{id}) that
 * its route changed: a stop confirmed, a run loaded, or the driver re-ordered
 * the drop-offs. They re-read the route. Best effort.
 */
export function announceRouteChanged(bookingId: string): void {
  void broadcast(`route:booking:${bookingId}`, 'route_changed', { booking_id: bookingId })
    .catch(() => {})
}

/* ── The driver's own drop-off order ───────────────────────────────────────── */

/**
 * The driver chose which drop-off to do next ("Go here next" on the nav map).
 * The run's stop order is saved so the office and the client see where the
 * truck is actually heading, and arrival times are worked out in that order.
 * Only the lead driver of the booking, and only on a run still being driven.
 */
export async function driverSetStopOrderService(
  tripId: string,
  tripStopIds: string[],
  actor: DriverActor,
) {
  const trip = await TripModel.findById(tripId)
  if (!trip) throw new Error(`Trip with ID ${tripId} not found`)
  const booking = await assertLeadDriverOnBooking(trip.booking_id, actor)

  if (trip.status === 'completed' || trip.status === 'cancelled') {
    throw new Error(`Trip ${trip.trip_number} is already ${trip.status}`)
  }
  const onTrip = new Set(trip.booking_trip_stops.map((s) => s.trip_stop_id))
  if (tripStopIds.some((id) => !onTrip.has(id))) {
    throw new Error('Those drop-offs are not all on this trip')
  }

  await TripModel.setStopOrder(tripId, tripStopIds)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_stop_order_changed',
    description: `Driver changed the drop-off order on trip ${trip.trip_number} of booking ${bookingRef(booking)}`,
  })

  void invalidateEta(trip.booking_id).catch(() => {})
  void refreshPlannedEta(trip.booking_id)
  announceRouteChanged(trip.booking_id)

  return TripModel.findById(tripId)
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
  const booking = await assertLeadDriverOnBooking(trip.booking_id, actor)

  if (stop.status === 'delivered') return stop
  if (trip.status !== 'in_transit' && trip.status !== 'completed') {
    throw new Error(`Confirm the pickup for trip ${trip.trip_number} before unloading at this drop-off`)
  }
  if (!proofPhotoUrl) {
    throw new Error('A proof-of-delivery photo is required to confirm this drop-off')
  }
  // The crew was replaced with the load still on the old vehicle: nothing is
  // unloaded from the new one until the transfer onto it is on record.
  await assertNoPendingLoadTransfer(trip.booking_id)

  const destinations = await BookingModel.findDestinationsByBookingId(trip.booking_id) ?? []
  const destination  = destinations.find((d) => d.destination_id === stop.destination_id)
  if (!destination) throw new Error('This drop-off is no longer on the booking')

  const fence = assertStopProximity(
    stopCoordinates(destination.latitude, destination.longitude),
    position,
    'drop-off',
  )

  const updated = await TripModel.setStopProof(tripStopId, 'delivered', proofPhotoUrl, position, fence, await driverIdOf(actor))
  // Unloading at a bay ends any pause — before the booking can complete under it.
  await endPauseOnProgress(trip.booking_id, actor)

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
  announceRouteChanged(trip.booking_id)

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
    if (remaining.length > 0) {
      // The next run's start is now knowable from when this one actually ended.
      void refreshPlannedEta(bookingId)
      return
    }

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

  const booking = await assertLeadDriverOnBooking(stop.booking_trips.booking_id, actor)

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
  const booking = await assertLeadDriverOnBooking(bookingId, actor)

  if ((booking as any).fleet_return_at) return booking
  if (booking.status !== 'delivered' && booking.status !== 'completed') {
    throw new Error('Confirm every drop-off before recording the return to the yard')
  }

  await TripModel.setFleetReturn(bookingId, position)

  logEvent({
    user_id:     actor.userId,
    log_type:    'vehicle_activity',
    action:      'driver_fleet_return_confirmed',
    description: `Driver confirmed the vehicle for booking ${bookingRef(booking)} is back in the company parking lot`,
  })

  // The return expires the vehicle's BLOWBAGETS pass. Put it on hold so the fleet
  // shows it as not ready, and tell the people who have to re-check it. A vendor
  // vehicle is not ours to inspect, so it has neither.
  const updated = await BookingModel.findById(bookingId)
  void holdReturnedVehicle(updated ?? booking)
  return updated ?? booking
}

async function holdReturnedVehicle(booking: BookingWithRelations): Promise<void> {
  try {
    const { truck_id } = await crewOnBooking(booking.booking_id)
    if (!truck_id) return
    const truck = await TruckModel.findById(truck_id)
    if (!truck) return

    // Only a vehicle that would otherwise read as ready. One already under
    // maintenance, deactivated or archived keeps the status that explains it.
    if (truck.status === 'available' || truck.status === 'in_use') {
      await TruckModel.update(truck_id, { status: 'recheck_due' })
    }

    const model = (truck as { truck_models?: { name?: string | null } | null }).truck_models?.name
    await notifyStage('vehicle_returned', booking, {
      vehicleLabel: model ? `${truck.plate_number} (${model})` : truck.plate_number,
    })
  } catch (err) {
    console.error('[trip] failed to hold returned vehicle', booking.booking_id, err)
  }
}

/* ── Trips and stops the phone named offline ──────────────────────────────── */

/** The trip id for booking + trip number. "not found" (404) when there is none. */
export async function resolveTripByNumber(bookingId: string, tripNumber: number): Promise<string> {
  if (!Number.isInteger(tripNumber) || tripNumber < 1) throw new Error('Trip not found')
  const trip = await TripModel.findByNumber(bookingId, tripNumber)
  if (!trip) throw new Error(`Trip ${tripNumber} not found on this booking`)
  return trip.trip_id
}

/** The trip stop id for booking + trip number + drop-off. */
export async function resolveTripStopByDestination(
  bookingId: string,
  tripNumber: number,
  destinationId: string,
): Promise<string> {
  if (!Number.isInteger(tripNumber) || tripNumber < 1) throw new Error('Trip not found')
  const trip = await TripModel.findByNumber(bookingId, tripNumber)
  const stop = trip?.booking_trip_stops.find((s) => s.destination_id === destinationId)
  if (!stop) throw new Error(`That drop-off was not found on trip ${tripNumber}`)
  return stop.trip_stop_id
}
