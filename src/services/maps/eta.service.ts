import { supabase } from '../../lib/supabase.js'
import { broadcast } from '../../lib/realtime.js'

/**
 * How long until the truck reaches each remaining stop.
 *
 * This is the question the client actually opens the tracking page to ask — "will
 * this make my receiving window" — and it is the reason a live position is worth
 * having at all. A dot moving on a map is interesting; an arrival time is
 * actionable.
 *
 * Computed from the driver's live position over the stops they have not yet
 * delivered, traffic-aware, and cached on the position row it was derived from.
 */

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY!
const ROUTES_API_URL  = 'https://routes.googleapis.com/directions/v2:computeRoutes'

/**
 * Only the leg durations. Deliberately NOT reusing `computeDirectionsService`:
 * that one asks for polylines, steps and traffic intervals and then makes
 * further Google Roads calls to snap the line, all of which exist to *draw* a
 * route. An ETA needs one number per leg, and the route is already drawn.
 */
const FIELD_MASK = 'routes.legs.duration,routes.duration'

/**
 * How often a new ETA is worth paying for.
 *
 * Every recomputation is a billed Routes call, and pings arrive every 5-10
 * seconds — so recomputing per ping would be roughly three thousand calls per
 * driver per day. It is also pointless: an ETA an hour out does not meaningfully
 * change in ninety seconds of driving.
 *
 * So the cadence follows the same logic as the app's upload tiers — spend where
 * it changes the answer. Far out, the estimate is coarse anyway and a ten-minute
 * refresh is plenty. Close in, the receiving bay is deciding whether to hold a
 * dock, and minutes matter.
 *
 * These four numbers are the entire cost knob for this feature. Roughly 20-30
 * calls per delivery at current settings; raise them if the Routes bill climbs.
 */
const RECOMPUTE_FAR_MS    = 10 * 60 * 1000  // more than 30 min out
const RECOMPUTE_MID_MS    =  5 * 60 * 1000  // 10-30 min out
const RECOMPUTE_NEAR_MS   =  2 * 60 * 1000  // under 10 min out
const FAR_THRESHOLD_S     = 30 * 60
const MID_THRESHOLD_S     = 10 * 60

/**
 * ...and recompute regardless of the clock once the truck has moved this far,
 * because at that point the cached estimate was computed from somewhere the
 * truck no longer is.
 */
const RECOMPUTE_MOVE_M = 2_000

export interface StopEta {
  destination_id: string
  /** Seconds from the moment of computation until arrival at this stop. */
  eta_seconds:    number
  /** The predicted arrival instant, so a client can render it without a clock. */
  eta_at:         string
}

export interface EtaStop {
  destination_id: string
  latitude:       number
  longitude:      number
}

interface CachedEta {
  eta_stops:       StopEta[] | null
  eta_computed_at: string | null
  eta_origin_lat:  number | null
  eta_origin_lng:  number | null
}

const EARTH_RADIUS_M = 6_371_008.8
const toRadians = (d: number) => (d * Math.PI) / 180

function metresBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(b.latitude - a.latitude)
  const dLon = toRadians(b.longitude - a.longitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude))
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** Google returns durations as a string of seconds, e.g. "834s". */
function parseDuration(value: string | undefined): number {
  if (!value) return 0
  const n = Number.parseFloat(value.replace(/s$/, ''))
  return Number.isFinite(n) ? n : 0
}

/** Whether the cached ETA is still good enough to serve. */
function isCacheFresh(
  cached: CachedEta,
  position: { latitude: number; longitude: number },
): boolean {
  // An empty list is a real answer — nothing left to estimate — and must count
  // as cached. Testing for length instead of presence would make every
  // subsequent ping rewrite the same empty result.
  if (!cached.eta_stops || !cached.eta_computed_at) return false

  const age = Date.now() - Date.parse(cached.eta_computed_at)
  if (!Number.isFinite(age) || age < 0) return false

  if (cached.eta_origin_lat != null && cached.eta_origin_lng != null) {
    const moved = metresBetween(
      { latitude: cached.eta_origin_lat, longitude: cached.eta_origin_lng },
      position,
    )
    if (moved >= RECOMPUTE_MOVE_M) return false
  }

  // Tier off the nearest stop's own estimate: the closer the truck is to the next
  // drop-off, the more a stale minute costs whoever is waiting for it. An empty
  // list yields Infinity, which lands in the slowest tier — right, since there is
  // nothing left to be early or late for.
  const soonest = Math.min(...cached.eta_stops.map((s) => s.eta_seconds))
  const remaining = soonest - age / 1000

  const budget = remaining > FAR_THRESHOLD_S ? RECOMPUTE_FAR_MS
    : remaining > MID_THRESHOLD_S            ? RECOMPUTE_MID_MS
    : RECOMPUTE_NEAR_MS

  return age < budget
}

/**
 * One traffic-aware Routes call: driver → stop 1 → stop 2 → ... Returns the
 * cumulative arrival time at each stop.
 *
 * Null on any upstream failure. An ETA is an enhancement to the map, and a
 * Google outage must not take the live position down with it — the caller keeps
 * whatever it had and tries again on the next eligible ping.
 */
async function computeLegEtas(
  from:  { latitude: number; longitude: number },
  stops: EtaStop[],
): Promise<StopEta[] | null> {
  if (stops.length === 0) return []

  const waypoint = (s: { latitude: number; longitude: number }) => ({
    location: { latLng: { latitude: s.latitude, longitude: s.longitude } },
  })

  const body = {
    origin:        waypoint(from),
    destination:   waypoint(stops[stops.length - 1]),
    intermediates: stops.slice(0, -1).map(waypoint),
    travelMode:    'DRIVE',
    // The whole point is an honest arrival time, so this must account for
    // traffic. It is the more expensive routing preference and deliberately so.
    routingPreference: 'TRAFFIC_AWARE',
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
      console.warn('[eta] Routes API error:', data?.error?.message ?? response.status)
      return null
    }

    const legs = data.routes?.[0]?.legs as Array<{ duration?: string }> | undefined
    if (!legs?.length) return null

    const now = Date.now()
    let cumulative = 0

    return stops.map((stop, i) => {
      cumulative += parseDuration(legs[i]?.duration)
      return {
        destination_id: stop.destination_id,
        eta_seconds:    Math.round(cumulative),
        eta_at:         new Date(now + cumulative * 1000).toISOString(),
      }
    })
  } catch (err) {
    console.warn('[eta] Routes call failed:', (err as Error)?.message)
    return null
  }
}

/**
 * Refresh the cached ETA for a booking if it has gone stale, otherwise do
 * nothing.
 *
 * Call this fire-and-forget from the ingest path: it must never delay the ping
 * response, and a driver's position is worth recording whether or not Google is
 * answering.
 */
export async function maybeRefreshEta(
  driverId:  string,
  bookingId: string,
  position:  { latitude: number; longitude: number },
): Promise<void> {
  const { data: cached, error: cacheError } = await supabase
    .from('driver_locations')
    .select('eta_stops, eta_computed_at, eta_origin_lat, eta_origin_lng')
    .eq('driver_id', driverId)
    .maybeSingle()

  if (cacheError) throw cacheError
  if (cached && isCacheFresh(cached as CachedEta, position)) return

  const stops = await remainingStops(bookingId)

  // Every stop done, or none with coordinates: nothing left to estimate. Written
  // as an empty list rather than left alone so the client stops showing an ETA
  // to a stop that has already been delivered.
  if (stops.length === 0) {
    await writeEta(driverId, bookingId, [], position)
    return
  }

  const etas = await computeLegEtas(position, stops)
  if (!etas) return

  await writeEta(driverId, bookingId, etas, position)
}

async function writeEta(
  driverId:  string,
  bookingId: string,
  etas:      StopEta[],
  position:  { latitude: number; longitude: number },
): Promise<void> {
  const { error } = await supabase.rpc('record_driver_eta', {
    p_driver_id:  driverId,
    p_booking_id: bookingId,
    p_eta_stops:  etas,
    p_origin_lat: position.latitude,
    p_origin_lng: position.longitude,
  })
  if (error) throw error

  // Pushed on its own event rather than folded into the position broadcast: the
  // ETA is recomputed every few minutes while positions arrive every few
  // seconds, so riding along would mean sending the same unchanged estimate
  // hundreds of times. A client watching over the socket would otherwise be
  // stuck with whatever estimate its first page load happened to fetch.
  void broadcast(`tracking:booking:${bookingId}`, 'driver_eta', {
    booking_id:      bookingId,
    eta_stops:       etas,
    eta_computed_at: new Date().toISOString(),
  }).catch((e) => console.warn(`[eta] broadcast failed for booking ${bookingId}:`, e?.message))
}

/** Undelivered stops, in the order the driver will reach them. */
async function remainingStops(bookingId: string): Promise<EtaStop[]> {
  const { data, error } = await supabase
    .from('booking_destinations')
    .select('destination_id, latitude, longitude, status, sequence_order')
    .eq('booking_id', bookingId)
    .eq('status', 'pending')
    .order('sequence_order', { ascending: true })

  if (error) throw error

  return (data ?? [])
    // A stop the office never geocoded cannot be routed to. Skipping it gives a
    // slightly optimistic ETA for the stops after it, which is better than no
    // ETA at all for any of them.
    .filter((d: { latitude: number | null; longitude: number | null }) =>
      d.latitude != null && d.longitude != null)
    .map((d: { destination_id: string; latitude: number; longitude: number }) => ({
      destination_id: d.destination_id,
      latitude:       Number(d.latitude),
      longitude:      Number(d.longitude),
    }))
}

/**
 * Force the next ping to buy a fresh ETA.
 *
 * Called when a stop is confirmed delivered: the remaining route just changed
 * shape, so every cached arrival time after it is wrong by however long the
 * driver spent at that bay.
 */
export async function invalidateEta(bookingId: string): Promise<void> {
  const { error } = await supabase
    .from('driver_locations')
    .update({ eta_computed_at: null })
    .eq('booking_id', bookingId)

  if (error) throw error
}
