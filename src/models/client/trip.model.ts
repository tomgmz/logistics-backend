import { supabase } from '../../lib/supabase.js'
import type { GeofenceOutcome, StopProofPosition } from '../../lib/stop-geofence.js'
import type {
  BookingTrip,
  BookingTripStop,
  TripWithStops,
  TripPlanInput,
} from '../../types/client/trip.types.js'
import { lineTotal, type PlanTrip } from '../../lib/trip-cargo.js'

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
  planned_departure_at,
  planned_arrival_at,
  planned_return_at,
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
    planned_arrival_at,
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
    ),
    booking_trip_cargo (
      trip_cargo_id,
      item_id,
      planned_qty,
      loaded_qty
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

/** A trip the truck has loaded (or finished): its plan is history and is kept. */
export const isStartedTrip = (t: { status: string }) => t.status === 'in_transit' || t.status === 'completed'

/**
 * Replace the not-yet-loaded part of a booking's trip plan.
 *
 * Ops sets how many runs the truck makes, which bays each serves and — with
 * `stops` — how much of each cargo line goes on each. A replace rather than a
 * diff: the plan is small and is set as a whole in one screen.
 *
 * Trips already loaded or run are KEPT exactly as they are: a driver holding a
 * truck loaded against trip 2 must not have trip 2 redefined underneath them.
 * Plan entries numbered like a started trip are ignored; every other trip is
 * deleted and re-created from `plan`. The service validates the plan first and
 * numbers it, so this only writes.
 */
async function replacePlan(
  bookingId: string,
  plan: TripPlanInput[],
  { insertOnly = false }: { insertOnly?: boolean } = {},
): Promise<TripWithStops[]> {
  const existing       = insertOnly ? [] : await findByBookingId(bookingId)
  const startedNumbers = new Set(existing.filter(isStartedTrip).map((t) => t.trip_number))

  const replaceable = existing.filter((t) => !isStartedTrip(t)).map((t) => t.trip_id)
  if (replaceable.length > 0) {
    // Stops and cargo go with them: both cascade on trip delete.
    const { error } = await supabase.from('booking_trips').delete().in('trip_id', replaceable)
    if (error) throw error
  }

  const fresh = plan
    .map((t, i) => ({ ...t, trip_number: t.trip_number ?? i + 1 }))
    .filter((t) => !startedNumbers.has(t.trip_number))
  if (fresh.length === 0) return findByBookingId(bookingId)

  const { data: trips, error: tripErr } = await supabase
    .from('booking_trips')
    .insert(fresh.map((t) => ({ booking_id: bookingId, trip_number: t.trip_number, notes: t.notes ?? null })))
    .select('trip_id, trip_number')
  if (tripErr) throw tripErr

  const byNumber = new Map((trips ?? []).map((t: any) => [t.trip_number as number, t.trip_id as string]))

  const stopRows = fresh.flatMap((t) =>
    t.destination_ids.map((destinationId, j) => ({
      trip_id:        byNumber.get(t.trip_number)!,
      destination_id: destinationId,
      sequence_order: j + 1,
    })),
  )
  if (stopRows.length === 0) return findByBookingId(bookingId)

  const { data: stops, error: stopErr } = await supabase
    .from('booking_trip_stops')
    .insert(stopRows)
    .select('trip_stop_id, trip_id, destination_id')
  if (stopErr) throw stopErr

  // How much of each cargo line each stop carries, when the plan says.
  const stopId = new Map((stops ?? []).map((s: any) => [`${s.trip_id}:${s.destination_id}`, s.trip_stop_id as string]))
  const cargoRows = fresh.flatMap((t) => {
    const tripId = byNumber.get(t.trip_number)!
    return (t.stops ?? []).flatMap((st) => st.items
      .filter((it) => it.quantity > 0 && stopId.has(`${tripId}:${st.destination_id}`))
      .map((it) => ({
        booking_id:   bookingId,
        trip_id:      tripId,
        trip_stop_id: stopId.get(`${tripId}:${st.destination_id}`)!,
        item_id:      it.item_id,
        planned_qty:  it.quantity,
      })))
  })
  if (cargoRows.length > 0) {
    const { error: cargoErr } = await supabase.from('booking_trip_cargo').insert(cargoRows)
    if (cargoErr) throw cargoErr
  }

  return findByBookingId(bookingId)
}

/**
 * Write a reshaped cargo plan (trip-cargo `rollCargo`) over the current one,
 * in place: existing trips and stops keep their ids — the phone may already
 * hold them in its offline queue — and only what changed is touched. Trips
 * past the end are created, trips that are gone (always the last) deleted.
 */
async function applyCargoPlan(
  bookingId: string,
  current:   TripWithStops[],
  next:      PlanTrip[],
): Promise<void> {
  const now      = new Date().toISOString()
  const byNumber = new Map(current.map((t) => [t.trip_number, t]))

  for (const plan of next) {
    if (plan.started) continue
    let trip = byNumber.get(plan.trip_number)
    let tripId = trip?.trip_id
    if (!tripId) {
      const { data, error } = await supabase
        .from('booking_trips')
        .insert({ booking_id: bookingId, trip_number: plan.trip_number })
        .select('trip_id')
        .single()
      if (error) throw error
      tripId = (data as any).trip_id as string
    }
    const stops = trip?.booking_trip_stops ?? []
    let order   = stops.reduce((n, s) => Math.max(n, s.sequence_order), 0)

    for (const ps of plan.stops) {
      let stop   = stops.find((s) => s.destination_id === ps.destination_id)
      let stopId = stop?.trip_stop_id
      if (!stopId) {
        const { data, error } = await supabase
          .from('booking_trip_stops')
          .insert({ trip_id: tripId, destination_id: ps.destination_id, sequence_order: ++order })
          .select('trip_stop_id')
          .single()
        if (error) throw error
        stopId = (data as any).trip_stop_id as string
      }
      const rows = stop?.booking_trip_cargo ?? []
      for (const c of ps.cargo) {
        const row = rows.find((r) => r.item_id === c.item_id)
        if (!row) {
          const { error } = await supabase.from('booking_trip_cargo').insert({
            booking_id: bookingId, trip_id: tripId, trip_stop_id: stopId,
            item_id: c.item_id, planned_qty: c.planned_qty, loaded_qty: c.loaded_qty,
          })
          if (error) throw error
        } else if (Number(row.planned_qty) !== c.planned_qty || (row.loaded_qty == null ? null : Number(row.loaded_qty)) !== c.loaded_qty) {
          const { error } = await supabase.from('booking_trip_cargo')
            .update({ planned_qty: c.planned_qty, loaded_qty: c.loaded_qty, updated_at: now })
            .eq('trip_cargo_id', row.trip_cargo_id)
          if (error) throw error
        }
      }
      const gone = rows.filter((r) => !ps.cargo.some((c) => c.item_id === r.item_id)).map((r) => r.trip_cargo_id)
      if (gone.length > 0) {
        const { error } = await supabase.from('booking_trip_cargo').delete().in('trip_cargo_id', gone)
        if (error) throw error
      }
    }

    const goneStops = stops
      .filter((s) => s.status === 'pending' && !plan.stops.some((p) => p.destination_id === s.destination_id))
      .map((s) => s.trip_stop_id)
    if (goneStops.length > 0) {
      const { error } = await supabase.from('booking_trip_stops').delete().in('trip_stop_id', goneStops)
      if (error) throw error
    }
  }

  const keep      = new Set(next.map((t) => t.trip_number))
  const goneTrips = current.filter((t) => !isStartedTrip(t) && !keep.has(t.trip_number)).map((t) => t.trip_id)
  if (goneTrips.length > 0) {
    const { error } = await supabase.from('booking_trips').delete().in('trip_id', goneTrips)
    if (error) throw error
  }
}

/** One trip by its number on the booking — how the phone names a trip it planned offline. */
async function findByNumber(bookingId: string, tripNumber: number): Promise<TripWithStops | null> {
  const { data, error } = await supabase
    .from('booking_trips')
    .select('trip_id')
    .eq('booking_id', bookingId)
    .eq('trip_number', tripNumber)
    .maybeSingle()
  if (error) throw error
  return data ? findById((data as any).trip_id) : null
}

/**
 * The default plan: one trip, every drop-off, in the booking's own order.
 *
 * Created on demand rather than at booking creation, so a booking made before
 * trips existed — or one whose plan was never set — still opens in the driver
 * app instead of showing an empty route. Idempotent: does nothing when the
 * booking already has trips.
 *
 * Callers race: assigning a booking refreshes its planned ETA (which reads the
 * plan) while the web reads it too. Concurrent calls for one booking share one
 * creation, and a creation that loses to another process (the unique trip
 * number) reads back the winner's plan instead of failing.
 */
const creatingPlan = new Map<string, Promise<TripWithStops[]>>()

function ensurePlan(bookingId: string): Promise<TripWithStops[]> {
  const inFlight = creatingPlan.get(bookingId)
  if (inFlight) return inFlight
  const run = createDefaultPlan(bookingId)
    .catch(async (err: any) => {
      if (err?.code === '23505') return findByBookingId(bookingId)
      throw err
    })
    .finally(() => creatingPlan.delete(bookingId))
  creatingPlan.set(bookingId, run)
  return run
}

async function createDefaultPlan(bookingId: string): Promise<TripWithStops[]> {
  const existing = await findByBookingId(bookingId)
  if (existing.length > 0) return existing

  const { data: destinations, error } = await supabase
    .from('booking_destinations')
    .select('destination_id, sequence_order')
    .eq('booking_id', bookingId)
    .order('sequence_order', { ascending: true })

  if (error) throw error
  if (!destinations?.length) return []

  // Every cargo line, all of it, on the one trip.
  const { data: cargo, error: cargoErr } = await supabase
    .from('booking_cargo_items')
    .select('item_id, destination_id, quantity')
    .eq('booking_id', bookingId)
  if (cargoErr) throw cargoErr

  const destinationIds = destinations.map((d: any) => d.destination_id as string)
  return replacePlan(bookingId, [{
    trip_number:     1,
    destination_ids: destinationIds,
    stops: destinationIds.map((destination_id) => ({
      destination_id,
      items: (cargo ?? [])
        .filter((c: any) => c.destination_id === destination_id)
        .map((c: any) => ({ item_id: c.item_id as string, quantity: lineTotal(c.quantity == null ? null : Number(c.quantity)) })),
    })),
  }], { insertOnly: true })
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

/**
 * Rewrite one trip's drop-off order: `orderedStopIds` first, in that order,
 * then the rest in their current order. Only the order within the trip moves;
 * the booking's own drop-off numbering (booking_destinations.sequence_order) is
 * untouched, so "Drop-off 3" stays drop-off 3.
 */
async function setStopOrder(tripId: string, orderedStopIds: string[]): Promise<void> {
  const trip = await findById(tripId)
  if (!trip) throw new Error(`Trip with ID ${tripId} not found`)

  const current = trip.booking_trip_stops.map((s) => s.trip_stop_id)
  const named   = orderedStopIds.filter((id) => current.includes(id))
  const next    = [...named, ...current.filter((id) => !named.includes(id))]

  for (const [i, id] of next.entries()) {
    const { error } = await supabase
      .from('booking_trip_stops')
      .update({ sequence_order: i + 1, updated_at: new Date().toISOString() })
      .eq('trip_stop_id', id)
    if (error) throw error
  }
}

export default {
  setStopOrder,
  findByBookingId,
  findById,
  findStopById,
  findStopsByDestinationId,
  replacePlan,
  applyCargoPlan,
  findByNumber,
  ensurePlan,
  setTripPickupProof,
  updateTripStatus,
  setStopProof,
  attachStopProof,
  setFleetReturn,
}
