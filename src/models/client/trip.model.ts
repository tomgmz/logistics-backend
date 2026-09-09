import { supabase } from '../../lib/supabase.js'
import type { GeofenceOutcome, StopProofPosition } from '../../lib/stop-geofence.js'
import type {
  BookingTrip,
  BookingTripStop,
  TripWithStops,
  TripPlanInput,
} from '../../types/client/trip.types.js'

/**
 * The runs a truck makes for one booking.
 *
 * A booking whose cargo is bigger than the body is completed by the SAME
 * vehicle shuttling — load, run, return, load again. `booking_trips` is one run;
 * `booking_trip_stops` is which drop-offs that run unloads at. See the
 * 20260910000000_booking_trips migration for why the two are separate tables.
 */

const TRIP_WITH_STOPS_SELECT = `
  trip_id,
  booking_id,
  trip_number,
  status,
  pickup_proof_photo_url,
  pickup_proof_at,
  pickup_proof_latitude,
  pickup_proof_longitude,
  pickup_proof_accuracy_m,
  pickup_proof_distance_m,
  pickup_proof_override_reason,
  notes,
  created_at,
  updated_at,
  booking_trip_stops (
    trip_stop_id,
    trip_id,
    destination_id,
    sequence_order,
    status,
    delivered_at,
    proof_photo_url,
    proof_at,
    proof_latitude,
    proof_longitude,
    proof_accuracy_m,
    proof_distance_m,
    proof_override_reason,
    booking_destinations (
      destination_id,
      address,
      sequence_order,
      latitude,
      longitude,
      notes,
      status
    )
  )
`

/**
 * Every trip on a booking, in the order the truck runs them, each with its stops
 * in the order it unloads at them.
 *
 * PostgREST returns an embedded array in insertion order, not the order of the
 * nested `order` clause, so the stops are sorted here rather than in the query —
 * a trip's stops arriving shuffled would put the driver's next-stop banner on
 * the wrong bay.
 */
async function findByBookingId(bookingId: string): Promise<TripWithStops[]> {
  const { data, error } = await supabase
    .from('booking_trips')
    .select(TRIP_WITH_STOPS_SELECT)
    .eq('booking_id', bookingId)
    .order('trip_number', { ascending: true })

  if (error) throw error

  return ((data ?? []) as unknown as TripWithStops[]).map((trip) => ({
    ...trip,
    booking_trip_stops: [...(trip.booking_trip_stops ?? [])]
      .sort((a, b) => a.sequence_order - b.sequence_order),
  }))
}

async function findById(tripId: string): Promise<TripWithStops | null> {
  const { data, error } = await supabase
    .from('booking_trips')
    .select(TRIP_WITH_STOPS_SELECT)
    .eq('trip_id', tripId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const trip = data as unknown as TripWithStops
  return {
    ...trip,
    booking_trip_stops: [...(trip.booking_trip_stops ?? [])]
      .sort((a, b) => a.sequence_order - b.sequence_order),
  }
}

/** One trip stop with the trip it belongs to — the row a drop-off confirmation writes. */
async function findStopById(tripStopId: string): Promise<(BookingTripStop & { booking_trips: BookingTrip }) | null> {
  const { data, error } = await supabase
    .from('booking_trip_stops')
    .select('*, booking_trips ( * )')
    .eq('trip_stop_id', tripStopId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as unknown as (BookingTripStop & { booking_trips: BookingTrip }) | null
}

/** Every trip stop bound for one drop-off, across all of the booking's trips. */
async function findStopsByDestinationId(destinationId: string): Promise<BookingTripStop[]> {
  const { data, error } = await supabase
    .from('booking_trip_stops')
    .select('*')
    .eq('destination_id', destinationId)

  if (error) throw error
  return (data ?? []) as BookingTripStop[]
}

/**
 * Replace a booking's trip plan wholesale.
 *
 * Ops sets how many runs the truck makes and which bays each run serves. This
 * is a replace rather than a diff because the plan is small, is set as a whole
 * in one screen, and a partial apply would leave a booking half-planned — a
 * state the driver app has no way to render.
 *
 * Refuses once any trip has been started, which is the guard that matters: a
 * driver holding a truck loaded against trip 2 must not have trip 2 redefined
 * underneath them. Re-planning an in-flight booking is a support action that
 * goes through the trips individually, not through this.
 */
async function replacePlan(bookingId: string, plan: TripPlanInput[]): Promise<TripWithStops[]> {
  const existing = await findByBookingId(bookingId)
  const started  = existing.filter((t) => t.status !== 'pending' && t.status !== 'cancelled')
  if (started.length > 0) {
    throw new Error(
      `Cannot re-plan trips: trip ${started[0].trip_number} has already started. ` +
      `Adjust the remaining trips individually instead.`,
    )
  }

  if (existing.length > 0) {
    // Stops go with them: booking_trip_stops cascades on trip delete.
    const { error } = await supabase
      .from('booking_trips')
      .delete()
      .eq('booking_id', bookingId)
    if (error) throw error
  }

  const { data: trips, error: tripErr } = await supabase
    .from('booking_trips')
    .insert(plan.map((t, i) => ({
      booking_id:  bookingId,
      trip_number: t.trip_number ?? i + 1,
      notes:       t.notes ?? null,
    })))
    .select('trip_id, trip_number')

  if (tripErr) throw tripErr

  const byNumber = new Map((trips ?? []).map((t: any) => [t.trip_number as number, t.trip_id as string]))

  const stopRows = plan.flatMap((t, i) =>
    t.destination_ids.map((destinationId, j) => ({
      trip_id:        byNumber.get(t.trip_number ?? i + 1)!,
      destination_id: destinationId,
      sequence_order: j + 1,
    })),
  )

  if (stopRows.length > 0) {
    const { error: stopErr } = await supabase.from('booking_trip_stops').insert(stopRows)
    if (stopErr) throw stopErr
  }

  return findByBookingId(bookingId)
}

/**
 * The default plan: one trip, every drop-off, in the booking's own order.
 *
 * Created on demand rather than at booking creation, so a booking made before
 * trips existed — or one whose plan was never set — still opens in the driver
 * app instead of showing an empty route. Idempotent: does nothing when the
 * booking already has trips.
 */
async function ensurePlan(bookingId: string): Promise<TripWithStops[]> {
  const existing = await findByBookingId(bookingId)
  if (existing.length > 0) return existing

  const { data: destinations, error } = await supabase
    .from('booking_destinations')
    .select('destination_id, sequence_order')
    .eq('booking_id', bookingId)
    .order('sequence_order', { ascending: true })

  if (error) throw error
  if (!destinations?.length) return []

  return replacePlan(bookingId, [{
    trip_number:     1,
    destination_ids: destinations.map((d: any) => d.destination_id as string),
  }])
}

/** Record the driver's proof of loading for one trip and put it on the road. */
async function setTripPickupProof(
  tripId: string,
  proofPhotoUrl: string,
  position?: StopProofPosition | null,
  fence?: GeofenceOutcome | null,
): Promise<BookingTrip> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('booking_trips')
    .update({
      status:                 'in_transit',
      pickup_proof_photo_url: proofPhotoUrl,
      pickup_proof_at:        now,
      updated_at:             now,
      ...proofPositionColumns('pickup_proof', position, fence),
    })
    .eq('trip_id', tripId)
    .select()
    .single()

  if (error) throw error
  return data as BookingTrip
}

async function updateTripStatus(tripId: string, status: BookingTrip['status']): Promise<BookingTrip> {
  const { data, error } = await supabase
    .from('booking_trips')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('trip_id', tripId)
    .select()
    .single()

  if (error) throw error
  return data as BookingTrip
}

/** Record the driver's proof of unloading at one stop of one trip. */
async function setStopProof(
  tripStopId: string,
  status: 'delivered' | 'failed',
  proofPhotoUrl: string,
  position?: StopProofPosition | null,
  fence?: GeofenceOutcome | null,
): Promise<BookingTripStop> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('booking_trip_stops')
    .update({
      status,
      delivered_at: status === 'delivered' ? now : null,
      updated_at:   now,
      proof_photo_url: proofPhotoUrl,
      proof_at:        now,
      ...proofPositionColumns('proof', position, fence),
    })
    .eq('trip_stop_id', tripStopId)
    .select()
    .single()

  if (error) throw error
  return data as BookingTripStop
}

/**
 * Attach a proof photo to a stop that is already confirmed.
 *
 * The driver confirms a bay at the bay — that is when the photo means anything —
 * but the photo does not always make it. A dead zone, a failed upload, a phone
 * that ran out of storage at the tailgate: the delivery happened and is
 * recorded, and the evidence arrives later. Without this the record would stay
 * permanently photo-less, because a confirmed stop is idempotent and re-sending
 * the confirmation is (correctly) a no-op.
 *
 * Deliberately narrow: it writes the photo and the timestamp, and NOTHING else.
 * The position and the distance recorded at the stop stay as they were — a photo
 * taken in the yard that evening must not overwrite where the driver actually
 * stood, which is the one fact the geofence exists to preserve.
 */
async function attachStopProof(tripStopId: string, proofPhotoUrl: string): Promise<BookingTripStop> {
  const { data, error } = await supabase
    .from('booking_trip_stops')
    .update({
      proof_photo_url: proofPhotoUrl,
      proof_at:        new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    })
    .eq('trip_stop_id', tripStopId)
    .select()
    .single()

  if (error) throw error
  return data as BookingTripStop
}

/** Where the driver stood when they confirmed, as columns. Mirrors booking.model. */
function proofPositionColumns(
  prefix:   'proof' | 'pickup_proof',
  position?: StopProofPosition | null,
  fence?:    GeofenceOutcome | null,
): Record<string, unknown> {
  return {
    [`${prefix}_latitude`]:        position?.latitude  ?? null,
    [`${prefix}_longitude`]:       position?.longitude ?? null,
    [`${prefix}_accuracy_m`]:      position?.accuracy_m ?? null,
    [`${prefix}_distance_m`]:      fence?.distance_m ?? null,
    [`${prefix}_override_reason`]: fence?.override_reason ?? null,
  }
}

/** Stamp the vehicle's return to the company lot. Closes the job for good. */
async function setFleetReturn(
  bookingId: string,
  position?: StopProofPosition | null,
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      fleet_return_at:        new Date().toISOString(),
      fleet_return_latitude:  position?.latitude  ?? null,
      fleet_return_longitude: position?.longitude ?? null,
      updated_at:             new Date().toISOString(),
    })
    .eq('booking_id', bookingId)

  if (error) throw error
}

export default {
  findByBookingId,
  findById,
  findStopById,
  findStopsByDestinationId,
  replacePlan,
  ensurePlan,
  setTripPickupProof,
  updateTripStatus,
  setStopProof,
  attachStopProof,
  setFleetReturn,
}
