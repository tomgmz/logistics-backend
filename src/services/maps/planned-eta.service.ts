import { supabase } from '../../lib/supabase.js'
import TripModel from '../../models/client/trip.model.js'
import type { TripWithStops } from '../../types/client/trip.types.js'

/**
 * Planned arrival times — the estimate BEFORE the truck moves.
 *
 * The live ETA (eta.service.ts) answers "when will it get here" from where the
 * truck is right now, and exists only while it is in transit. This answers the
 * same question at planning time, from Google's predicted traffic for the
 * planned departure.
 *
 * Google knows driving time and nothing else, so each run is chained the way
 * the truck actually works it:
 *
 *   call time → load → drive → stop 1 → unload → drive → stop 2 → unload
 *             → drive back → reload → trip 2 …
 *
 * The same shape as fleet planning systems (service time per stop, reloads
 * between runs). The allowances below are flat defaults until real arrival
 * timestamps give per-client averages to replace them.
 *
 * Stop times after a trip's first stop include the earlier stops' unloading, so
 * they carry the allowance's error. The live ETA takes over once the truck is
 * moving.
 */

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY!
const ROUTES_API_URL  = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const FIELD_MASK      = 'routes.legs.duration'

/** Unloading at each drop-off. A typical FMCG receiving bay; per-client later. */
const UNLOAD_MINUTES_PER_STOP = 30
/**
 * Loading at the origin before each run. Also applied after the call time for
 * trip 1: call time is when the truck reports to the warehouse, not when it
 * leaves loaded.
 */
const LOAD_MINUTES_PER_TRIP = 45

/** PH is a fixed UTC+8 with no DST. */
const PH_OFFSET = '+08:00'

const MINUTE_MS = 60_000

interface Point { latitude: number; longitude: number }

interface PlannedStop { trip_stop_id: string; planned_arrival_at: string }
interface PlannedTrip {
  trip_id:              string
  planned_departure_at: string
  planned_arrival_at:   string
  planned_return_at:    string
  stops:                PlannedStop[]
}

function toPoint(lat: unknown, lng: unknown): Point | null {
  const latitude  = Number(lat)
  const longitude = Number(lng)
  if (lat == null || lng == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude }
}

/** Google returns durations as a string of seconds, e.g. "834s". */
function parseDuration(value: string | undefined): number {
  if (!value) return 0
  const n = Number.parseFloat(value.replace(/s$/, ''))
  return Number.isFinite(n) ? n : 0
}

/** When the truck reports to the origin: schedule_date + call_time, PH time. */
function callTimeAt(scheduleDate: unknown, callTime: unknown): Date | null {
  const day  = String(scheduleDate ?? '').slice(0, 10)
  const time = String(callTime ?? '').slice(0, 8).replace(/^(\d{2}:\d{2})$/, '$1:00')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return null
  const at = new Date(`${day}T${time}${PH_OFFSET}`)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * Leg durations in seconds for from → points… → to, departing at `departAt`.
 *
 * The Routes API refuses a departure time in the past, so a departure that has
 * already gone (a run that slipped, a started trip) is sent as "now" — the
 * traffic that matters is the traffic the truck will actually meet.
 */
async function legDurations(from: Point, points: Point[], to: Point, departAt: Date): Promise<number[] | null> {
  const waypoint = (p: Point) => ({ location: { latLng: p } })
  const soon     = Date.now() + MINUTE_MS

  const body = {
    origin:            waypoint(from),
    destination:       waypoint(to),
    intermediates:     points.map(waypoint),
    travelMode:        'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    departureTime:     new Date(Math.max(departAt.getTime(), soon)).toISOString(),
  }

  try {
    const response = await fetch(ROUTES_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    })
    const data = await response.json()
    if (!response.ok) {
      console.warn('[planned-eta] Routes API error:', data?.error?.message ?? response.status)
      return null
    }
    const legs = data.routes?.[0]?.legs as Array<{ duration?: string }> | undefined
    // One leg per intermediate point plus the final one.
    if (!legs || legs.length !== points.length + 1) return null
    return legs.map((l) => parseDuration(l.duration))
  } catch (err) {
    console.warn('[planned-eta] Routes call failed:', (err as Error)?.message)
    return null
  }
}

function sortedStops(trip: TripWithStops) {
  return (trip.booking_trip_stops ?? []).slice().sort((a, b) => a.sequence_order - b.sequence_order)
}

/** One run, planned from its departure. Null if a stop has no coordinates or Google fails. */
async function planTrip(trip: TripWithStops, origin: Point, departAt: Date): Promise<PlannedTrip | null> {
  const stops  = sortedStops(trip)
  const points = stops.map((s) => toPoint(s.booking_destinations?.latitude, s.booking_destinations?.longitude))
  if (stops.length === 0 || points.some((p) => !p)) return null

  const legs = await legDurations(origin, points as Point[], origin, departAt)
  if (!legs) return null

  let cursor = departAt.getTime()
  const planned: PlannedStop[] = stops.map((stop, i) => {
    cursor += legs[i] * 1000
    const arrival = new Date(cursor).toISOString()
    cursor += UNLOAD_MINUTES_PER_STOP * MINUTE_MS
    return { trip_stop_id: stop.trip_stop_id, planned_arrival_at: arrival }
  })
  cursor += legs[legs.length - 1] * 1000

  return {
    trip_id:              trip.trip_id,
    planned_departure_at: departAt.toISOString(),
    planned_arrival_at:   planned[planned.length - 1].planned_arrival_at,
    planned_return_at:    new Date(cursor).toISOString(),
    stops:                planned,
  }
}

async function writeTrip(plan: PlannedTrip): Promise<void> {
  const { error } = await supabase
    .from('booking_trips')
    .update({
      planned_departure_at: plan.planned_departure_at,
      planned_arrival_at:   plan.planned_arrival_at,
      planned_return_at:    plan.planned_return_at,
    })
    .eq('trip_id', plan.trip_id)
  if (error) throw error

  for (const stop of plan.stops) {
    const { error: stopError } = await supabase
      .from('booking_trip_stops')
      .update({ planned_arrival_at: stop.planned_arrival_at })
      .eq('trip_stop_id', stop.trip_stop_id)
    if (stopError) throw stopError
  }
}

/** Clear a run's estimate when it can no longer be chained (see below). */
async function clearTrip(trip: TripWithStops): Promise<void> {
  const { error } = await supabase
    .from('booking_trips')
    .update({ planned_departure_at: null, planned_arrival_at: null, planned_return_at: null })
    .eq('trip_id', trip.trip_id)
  if (error) throw error

  const { error: stopError } = await supabase
    .from('booking_trip_stops')
    .update({ planned_arrival_at: null })
    .eq('trip_id', trip.trip_id)
  if (stopError) throw stopError
}

/**
 * Re-plan every run on a booking that has not finished, and roll the last one up
 * into `bookings.estimated_delivery`.
 *
 * Call it whenever the answer can change: the plan is set, the truck is
 * assigned, the schedule moves, a run is loaded (its real departure replaces the
 * planned one) or a run finishes (the next one's start becomes knowable).
 *
 * Best effort and never throws: an estimate is an enhancement, and a Google
 * outage must not fail the assignment or the driver's confirmation that
 * triggered it.
 *
 * Cost: one Routes call per unfinished run, plus one for the drive back after a
 * finished run whose successor has not started. Completed runs and runs already
 * planned from their real loading time are not re-queried.
 */
export async function refreshPlannedEta(bookingId: string): Promise<void> {
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('booking_id, status, schedule_date, call_time, origin_latitude, origin_longitude')
      .eq('booking_id', bookingId)
      .maybeSingle()
    if (error) throw error
    if (!booking) return
    // Planned once a truck is on it (the trip plan exists from then), and kept
    // current until the last run is done.
    if (booking.status !== 'assigned' && booking.status !== 'in_transit') return

    const origin = toPoint(booking.origin_latitude, booking.origin_longitude)
    const callAt = callTimeAt(booking.schedule_date, booking.call_time)
    if (!origin || !callAt) return

    // ensurePlan: a booking nobody has split yet is one run over every drop-off.
    const trips = (await TripModel.ensurePlan(bookingId))
      .filter((t) => t.status !== 'cancelled')
      .sort((a, b) => a.trip_number - b.trip_number)
    if (trips.length === 0) return

    // When the truck is next free at the origin to load. Trip 1 starts from the
    // call time; every later trip from the one before it.
    let readyAt: Date | null = callAt
    let lastArrival: string | null = null

    for (const t of trips) {
      if (t.status === 'completed') {
        // Its plan is history — keep it. The next run starts once this one's
        // truck is back: from the last real delivery, plus unloading, plus the
        // drive home.
        lastArrival = t.planned_arrival_at ?? lastArrival
        const stops     = sortedStops(t)
        const delivered = stops.map((s) => s.delivered_at).filter(Boolean).sort().pop()
        const lastStop  = stops[stops.length - 1]
        const from      = toPoint(lastStop?.booking_destinations?.latitude, lastStop?.booking_destinations?.longitude)
        if (!delivered || !from) { readyAt = t.planned_return_at ? new Date(t.planned_return_at) : null; continue }

        const leftAt = new Date(Date.parse(delivered) + UNLOAD_MINUTES_PER_STOP * MINUTE_MS)
        const back   = await legDurations(from, [], origin, leftAt)
        readyAt = back ? new Date(leftAt.getTime() + back[0] * 1000) : null
        continue
      }

      let departAt: Date | null
      if (t.status === 'in_transit' && t.pickup_proof_at) {
        // Loaded: the real departure replaces the planned one. Already planned
        // from it? Nothing changed, so don't pay for the same answer again.
        departAt = new Date(t.pickup_proof_at)
        if (t.planned_departure_at && Date.parse(t.planned_departure_at) === departAt.getTime() && t.planned_return_at) {
          lastArrival = t.planned_arrival_at ?? lastArrival
          readyAt     = new Date(t.planned_return_at)
          continue
        }
      } else {
        departAt = readyAt ? new Date(readyAt.getTime() + LOAD_MINUTES_PER_TRIP * MINUTE_MS) : null
      }

      const plan = departAt ? await planTrip(t, origin, departAt) : null
      if (!plan) {
        // Can't place this run, so nothing after it can be placed either. Clear
        // rather than leave a stale time from an older plan on screen.
        await clearTrip(t)
        readyAt     = null
        lastArrival = null
        continue
      }

      await writeTrip(plan)
      readyAt     = new Date(plan.planned_return_at)
      lastArrival = plan.planned_arrival_at
    }

    const { error: bookingError } = await supabase
      .from('bookings')
      .update({ estimated_delivery: lastArrival })
      .eq('booking_id', bookingId)
    if (bookingError) throw bookingError
  } catch (err) {
    console.warn('[planned-eta] could not refresh', bookingId, (err as Error)?.message ?? err)
  }
}
