import { supabase } from '../../lib/supabase.js'
import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from '../../lib/log-system.js'

/**
 * "Can the truck make the pick-up if the driver leaves at this call time?"
 *
 * A warning for operations while setting the driver call time in the Trip
 * Planner, never a block (user 2026-11-26): Google's traffic-aware drive time
 * from the company parking to the pick-up point, departing at the call time.
 * Google has no truck mode and the pre-trip checks (BLOWBAGETS, odometer photo)
 * take time too, so it is a floor, not a promise.
 *
 * The parking is where the vehicle was last confirmed back ("back at the
 * parking" records the phone's position); with none for this vehicle, the
 * latest return of any company vehicle (they share the 8338 lot). With no
 * return on record at all, there is nothing to measure from.
 *
 * Cost: one Routes call per distinct (booking, call instant), cached 10 min.
 */

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY!
const ROUTES_API_URL  = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const CACHE_MS        = 10 * 60_000

export interface CallTimeCheck {
  /** Drive minutes from the parking to the pick-up, or null when unknown. */
  drive_minutes: number | null
  /** call time + drive, ISO. */
  arrives_at:    string | null
  /** The client's pick-up time, ISO. */
  pickup_at:     string | null
  /** Minutes the truck would arrive after the pick-up time (≤ 0 = in time). */
  late_minutes:  number | null
  /** Why there is no figure. */
  reason?:       'no_parking' | 'no_pickup_point' | 'no_route'
}

const cache = new Map<string, { at: number; value: CallTimeCheck }>()

function phInstant(day: string, time: string): number | null {
  const hm = String(time ?? '').slice(0, 5)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(hm)) return null
  const at = Date.parse(`${day}T${hm}:00+08:00`)
  return Number.isFinite(at) ? at : null
}

interface Point { latitude: number; longitude: number }

function point(lat: unknown, lng: unknown): Point | null {
  const latitude = Number(lat), longitude = Number(lng)
  if (lat == null || lng == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude }
}

/** Where the booking's vehicle was last confirmed back, else any company vehicle's latest return. */
async function parkingPoint(bookingId: string): Promise<Point | null> {
  const { data: assignment } = await supabase
    .from('truck_assignments')
    .select('truck_id')
    .eq('booking_id', bookingId)
    .order('assigned_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (assignment?.truck_id) {
    const { data: same } = await supabase
      .from('truck_assignments')
      .select('booking_id')
      .eq('truck_id', assignment.truck_id)
    const ids = (same ?? []).map((r: { booking_id: string }) => r.booking_id).filter((id) => id !== bookingId)
    if (ids.length) {
      const { data } = await supabase
        .from('bookings')
        .select('fleet_return_latitude, fleet_return_longitude')
        .in('booking_id', ids.slice(0, 200))
        .not('fleet_return_latitude', 'is', null)
        .order('fleet_return_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const p = point(data?.fleet_return_latitude, data?.fleet_return_longitude)
      if (p) return p
    }
  }

  const { data: any } = await supabase
    .from('bookings')
    .select('fleet_return_latitude, fleet_return_longitude')
    .not('fleet_return_latitude', 'is', null)
    .order('fleet_return_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return point(any?.fleet_return_latitude, any?.fleet_return_longitude)
}

async function driveSeconds(from: Point, to: Point, departAt: number): Promise<number | null> {
  const body: Record<string, unknown> = {
    origin:            { location: { latLng: from } },
    destination:       { location: { latLng: to } },
    travelMode:        'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
  }
  // Google refuses a departure in the past.
  if (departAt > Date.now() + 60_000) body.departureTime = new Date(departAt).toISOString()
  try {
    const res  = await fetch(ROUTES_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'routes.duration' },
      body:    JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      logSystemThrottled('google-maps.call-check', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
        log_level: 'warn', event_type: 'external_api', source: 'google-maps.call-check',
        message:   `Routes API error: ${data?.error?.message ?? res.status}`, metadata: { status: res.status },
      })
      return null
    }
    const s = Number.parseFloat(String(data.routes?.[0]?.duration ?? '').replace(/s$/, ''))
    return Number.isFinite(s) ? s : null
  } catch {
    return null
  }
}

export async function checkDriverCallService(bookingId: string, day: string, time: string): Promise<CallTimeCheck> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('schedule_date, call_time, origin_latitude, origin_longitude')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (error) throw error
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  const callAt   = phInstant(day, time)
  const pickupAt = phInstant(String(booking.schedule_date ?? '').slice(0, 10), String(booking.call_time ?? ''))
  const empty: CallTimeCheck = { drive_minutes: null, arrives_at: null, pickup_at: pickupAt ? new Date(pickupAt).toISOString() : null, late_minutes: null }
  if (callAt == null) return empty

  const key = `${bookingId}|${callAt}|${pickupAt}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const to = point(booking.origin_latitude, booking.origin_longitude)
  if (!to) return { ...empty, reason: 'no_pickup_point' }
  const from = await parkingPoint(bookingId)
  if (!from) return { ...empty, reason: 'no_parking' }

  const secs = await driveSeconds(from, to, callAt)
  if (secs == null) return { ...empty, reason: 'no_route' }

  const arrives = callAt + secs * 1000
  const value: CallTimeCheck = {
    drive_minutes: Math.round(secs / 60),
    arrives_at:    new Date(arrives).toISOString(),
    pickup_at:     empty.pickup_at,
    late_minutes:  pickupAt != null ? Math.round((arrives - pickupAt) / 60_000) : null,
  }
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}
