import { supabase } from '../../lib/supabase.js'
import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from '../../lib/log-system.js'

/**
 * How far a booking's route goes by road, and the crew rule that hangs off it.
 *
 * Over SECOND_DRIVER_THRESHOLD_KM the booking needs a second driver; at or
 * under it there is no second driver, only an optional helper whose name is
 * recorded for information.
 *
 * The distance is the whole route one way: pickup, then every drop-off in its
 * sequence. A multi-stop city run can go over the line even when every stop is
 * close — that is intended, it is the driving that tires the driver.
 *
 * Cost: one Routes call per booking, cached on bookings.route_distance_m. The
 * cache is keyed on the coordinates it was measured over, so moving a stop,
 * adding one or re-ordering them re-measures on the next read.
 */

export const SECOND_DRIVER_THRESHOLD_KM = 30

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY!
const ROUTES_API_URL  = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const FIELD_MASK      = 'routes.distanceMeters'

/** Routes API allows 25 intermediates, so one call covers 27 points. */
const MAX_POINTS_PER_CALL = 27

interface Point { latitude: number; longitude: number }

export interface RouteDistance {
  /** Road distance in km, one decimal. Null when it could not be measured. */
  distance_km:            number | null
  threshold_km:           number
  /** True over the threshold, false at or under it, null when unknown. */
  requires_second_driver: boolean | null
}

function toPoint(lat: unknown, lng: unknown): Point | null {
  const latitude  = Number(lat)
  const longitude = Number(lng)
  if (lat == null || lng == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude }
}

/** The cache key: every point, rounded to ~1 m, in route order. */
function keyFor(points: Point[]): string {
  return points.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join('|')
}

/**
 * Network-level retries: a reset connection ("fetch failed") is common on a cold
 * socket, and a local TLS-inspecting proxy resets the first couple outright.
 * An API error is a real answer and is not retried.
 */
async function postWithRetry(init: RequestInit, retries = 2): Promise<Response> {
  try {
    return await fetch(ROUTES_API_URL, init)
  } catch (err) {
    if (retries <= 0) throw err
    await new Promise((r) => setTimeout(r, 500))
    return postWithRetry(init, retries - 1)
  }
}

async function measureLeg(points: Point[]): Promise<number | null> {
  const waypoint = (p: Point) => ({ location: { latLng: p } })
  const body = {
    origin:            waypoint(points[0]),
    destination:       waypoint(points[points.length - 1]),
    intermediates:     points.slice(1, -1).map(waypoint),
    travelMode:        'DRIVE',
    // Distance only — traffic changes the time, not the road taken enough to matter here.
    routingPreference: 'TRAFFIC_UNAWARE',
  }

  try {
    const response = await postWithRetry({
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
      console.warn('[route-distance] Routes API error:', data?.error?.message ?? response.status)
      logSystemThrottled('google-maps.route-distance', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
        log_level:  'warn',
        event_type: 'external_api',
        source:     'google-maps.route-distance',
        message:    `Routes API error: ${data?.error?.message ?? response.status}`,
        metadata:   { status: response.status },
      })
      return null
    }
    const meters = Number(data.routes?.[0]?.distanceMeters)
    return Number.isFinite(meters) ? meters : null
  } catch (err) {
    console.warn('[route-distance] Routes call failed:', (err as Error)?.message)
    logSystemThrottled('google-maps.route-distance', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'google-maps.route-distance',
      message:    `Routes call failed: ${(err as Error)?.message ?? String(err)}`,
    })
    return null
  }
}

/** Road metres along points in order, split into calls the API accepts. */
async function measure(points: Point[]): Promise<number | null> {
  let total = 0
  for (let start = 0; start < points.length - 1; start += MAX_POINTS_PER_CALL - 1) {
    const leg = await measureLeg(points.slice(start, start + MAX_POINTS_PER_CALL))
    if (leg == null) return null
    total += leg
  }
  return total
}

function result(meters: number | null): RouteDistance {
  const km = meters == null ? null : Math.round(meters / 100) / 10
  return {
    distance_km:            km,
    threshold_km:           SECOND_DRIVER_THRESHOLD_KM,
    requires_second_driver: km == null ? null : km > SECOND_DRIVER_THRESHOLD_KM,
  }
}

/**
 * The booking's route distance. Never throws for a Google failure or missing
 * coordinates — those come back as distance_km null, and the caller decides
 * what an unknown distance means.
 */
export async function getRouteDistance(bookingId: string): Promise<RouteDistance> {
  const [{ data: booking, error }, { data: stops, error: stopsError }] = await Promise.all([
    supabase
      .from('bookings')
      .select('booking_id, origin_latitude, origin_longitude, route_distance_m, route_distance_key')
      .eq('booking_id', bookingId)
      .maybeSingle(),
    supabase
      .from('booking_destinations')
      .select('latitude, longitude, sequence_order')
      .eq('booking_id', bookingId)
      .order('sequence_order', { ascending: true }),
  ])
  if (error) throw error
  if (stopsError) throw stopsError
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  const origin = toPoint(booking.origin_latitude, booking.origin_longitude)
  const points = (stops ?? []).map((s) => toPoint(s.latitude, s.longitude))
  if (!origin || points.length === 0 || points.some((p) => !p)) return result(null)

  const route = [origin, ...(points as Point[])]
  const key   = keyFor(route)
  if (booking.route_distance_key === key && booking.route_distance_m != null) {
    return result(booking.route_distance_m)
  }

  const meters = await measure(route)
  if (meters == null) return result(null)

  const { error: writeError } = await supabase
    .from('bookings')
    .update({ route_distance_m: Math.round(meters), route_distance_key: key })
    .eq('booking_id', bookingId)
  if (writeError) console.warn('[route-distance] could not cache', bookingId, writeError.message)

  return result(meters)
}
