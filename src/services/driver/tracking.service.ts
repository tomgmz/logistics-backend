import { supabase } from '../../lib/supabase.js'
import { broadcast } from '../../lib/realtime.js'
import {
  assertDriverOnBooking,
  assertBookingVisible,
  type DriverActor,
  type BookingViewer,
} from '../client/booking.service.js'
import { maybeRefreshEta, type StopEta } from '../maps/eta.service.js'

/**
 * Live driver position, from the phone to the client's map.
 *
 * This is the one write path in the system that is deliberately *lossy*. Stop
 * confirmations are durable to a fault — they queue on the device and retry for
 * hours because losing one erases a delivery that happened. A position is the
 * opposite: it is only worth anything while it is current, and a ping that
 * arrives late is worse than one that never arrives, because it drags the truck
 * backwards across the client's map to somewhere it no longer is. So the app
 * never queues these, and this service throws away anything stale.
 *
 * Everything here runs on the hot path — a driver in traffic sends one of these
 * every 5-10 seconds — so it does the minimum: one ownership check, one UPSERT,
 * one history insert, one broadcast.
 */

/**
 * How old a fix may be, measured on the device's clock, before it is discarded.
 *
 * Two minutes is well past the slowest tier the app sends on (60 s while the
 * truck is stopped), so a healthy device never trips it; what does trip it is a
 * ping that sat in a dead zone, or a device whose clock is wrong. Both would
 * move the marker somewhere untrue.
 */
const MAX_FIX_AGE_MS = 2 * 60 * 1000

/**
 * A fix dated in the future is a broken device clock, not a prediction. A small
 * tolerance absorbs ordinary clock skew; beyond it the fix cannot be ordered
 * against the ones already stored and is dropped.
 */
const MAX_FIX_SKEW_MS = 60 * 1000

export interface LocationPing {
  latitude:     number
  longitude:    number
  accuracy_m?:  number | null
  speed_mps?:   number | null
  heading_deg?: number | null
  recorded_at:  string
}

export interface DriverPosition {
  booking_id:   string
  driver_id:    string
  latitude:     number
  longitude:    number
  accuracy_m:   number | null
  speed_mps:    number | null
  heading_deg:  number | null
  recorded_at:  string
}

/** A position plus whatever arrival estimate has been computed from it. */
export interface DriverPositionWithEta extends DriverPosition {
  eta_stops:       StopEta[] | null
  eta_computed_at: string | null
}

/**
 * The driver row behind a signed-in user.
 *
 * Cached because it is asked on every ping and the answer never changes for the
 * life of a session — a user is a driver or is not. Deliberately *not*
 * `findDriverByUser` from availability.service: that one reconciles the driver's
 * status as a side effect, which is right for a screen the driver opens and
 * wrong to run hundreds of times an hour.
 */
const driverIdByUser = new Map<string, string>()

async function resolveDriverId(userId: string): Promise<string> {
  const cached = driverIdByUser.get(userId)
  if (cached) return cached

  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('No driver profile found for this account')

  driverIdByUser.set(userId, data.driver_id)
  return data.driver_id
}

/**
 * iOS and Android both report -1 for "this value is unavailable". Stored as null
 * so a consumer never has to know that, and so an unknown heading can't be
 * mistaken for due north.
 */
function normaliseSensor(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return value < 0 ? null : value
}

/**
 * Record a fix and push it to whoever is watching this booking.
 *
 * Returns null when the fix was accepted-but-ignored (too old, or the booking
 * isn't running). The caller answers 202 for that: the app has nothing useful to
 * do about it, and turning it into an error would only make drivers' phones
 * retry something that must not be retried.
 */
export async function recordDriverPositionService(
  bookingId: string,
  ping: LocationPing,
  actor: DriverActor,
): Promise<DriverPosition | null> {
  const booking = await assertDriverOnBooking(bookingId, actor)

  // The device stops pinging when the trip ends, but a ping already in flight
  // can land just after. More importantly this is what actually enforces "never
  // track a driver who isn't working" — the on-device gate is a convenience, and
  // a convenience is not a privacy control.
  if (booking.status !== 'in_transit') return null

  const recordedAt = Date.parse(ping.recorded_at)
  if (Number.isNaN(recordedAt)) return null

  const age = Date.now() - recordedAt
  if (age > MAX_FIX_AGE_MS || age < -MAX_FIX_SKEW_MS) return null

  // An admin can hit this route for support, but only a driver has a driver row
  // to hang a position on. There is nothing to record for anyone else.
  if (!actor.userId) return null
  const driverId = await resolveDriverId(actor.userId)

  const position: DriverPosition = {
    booking_id:  bookingId,
    driver_id:   driverId,
    latitude:    ping.latitude,
    longitude:   ping.longitude,
    accuracy_m:  normaliseSensor(ping.accuracy_m),
    speed_mps:   normaliseSensor(ping.speed_mps),
    heading_deg: normaliseSensor(ping.heading_deg),
    recorded_at: new Date(recordedAt).toISOString(),
  }

  // One call does both writes and holds the "never move backwards in device
  // time" guard, which PostgREST's upsert cannot express. See the function's
  // comment in 20260829020000_driver_live_location.sql.
  const { error: writeError } = await supabase.rpc('record_driver_position', {
    p_driver_id:   driverId,
    p_booking_id:  bookingId,
    p_latitude:    position.latitude,
    p_longitude:   position.longitude,
    p_accuracy_m:  position.accuracy_m,
    p_speed_mps:   position.speed_mps,
    p_heading_deg: position.heading_deg,
    p_recorded_at: position.recorded_at,
  })

  if (writeError) throw writeError

  // Fire-and-forget: the position is already recorded, and the next ping is only
  // seconds behind, so a failed push is not worth failing the request over.
  void broadcast(`tracking:booking:${bookingId}`, 'driver_position', position)
    .catch((e) => console.warn(`[tracking] broadcast failed for booking ${bookingId}:`, e?.message))

  // Likewise fire-and-forget, and for a stronger reason: this can make a call to
  // Google, which is slow and can fail. The driver's position must be recorded
  // and pushed on its own schedule regardless. Most pings find a fresh cached
  // ETA and return without doing anything.
  void maybeRefreshEta(driverId, bookingId, position)
    .catch((e) => console.warn(`[tracking] eta refresh failed for booking ${bookingId}:`, e?.message))

  return position
}

/**
 * The latest position for a booking, for the map's first paint and for the
 * fallback poll when the realtime channel is down.
 *
 * The viewer is mandatory rather than optional for the reason given on
 * `BookingViewer`: an optional one lets a forgotten call site skip the check,
 * and the thing being guarded here is a live vehicle location.
 */
export async function getLivePositionService(
  bookingId: string,
  viewer:    BookingViewer,
): Promise<DriverPositionWithEta | null> {
  await assertBookingVisible(bookingId, viewer)

  const { data, error } = await supabase
    .from('driver_locations')
    .select(
      'booking_id, driver_id, latitude, longitude, accuracy_m, speed_mps, heading_deg, recorded_at, ' +
      'eta_stops, eta_computed_at',
    )
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) throw error
  return (data as DriverPositionWithEta | null) ?? null
}

/**
 * How long a breadcrumb trail is kept. Comfortably outlives the billing period a
 * detention or route dispute would be raised against.
 */
export const LOCATION_RETENTION_DAYS = 30

const PRUNE_TICK_MS = 24 * 60 * 60 * 1000

/**
 * Drop breadcrumbs past the retention window.
 *
 * Deleted in bounded batches rather than one statement: at fleet scale a day's
 * worth is tens of thousands of rows, and an unbounded delete would hold locks
 * on the table the ingest path writes to on every ping. Exported so it can be
 * driven from a script.
 */
export async function pruneLocationHistory(retentionDays = LOCATION_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const BATCH = 5_000
  let removed = 0

  for (;;) {
    const { data: doomed, error: selectError } = await supabase
      .from('driver_location_history')
      .select('location_id')
      .lt('recorded_at', cutoff)
      .limit(BATCH)

    if (selectError) throw selectError
    const ids = (doomed ?? []).map((r: { location_id: string }) => r.location_id)
    if (ids.length === 0) break

    const { error: deleteError } = await supabase
      .from('driver_location_history')
      .delete()
      .in('location_id', ids)

    if (deleteError) throw deleteError
    removed += ids.length
    if (ids.length < BATCH) break
  }

  return removed
}

let pruneTimer: NodeJS.Timeout | null = null

/**
 * Start the daily prune. Safe to call once at boot; a second call is ignored.
 *
 * Runs here rather than in pg_cron so everything on a timer is in one place,
 * matching the fleet re-check scheduler. With more than one server process this
 * fires per process, which is harmless — the second pass finds nothing left to
 * delete.
 */
export function startLocationPruneScheduler(): void {
  if (pruneTimer) return

  const tick = () => {
    pruneLocationHistory()
      .then((n) => { if (n > 0) console.log(`[tracking] pruned ${n} location rows`) })
      .catch((err) => console.error('[tracking] prune failed', err))
  }

  pruneTimer = setInterval(tick, PRUNE_TICK_MS)
  pruneTimer.unref?.()
  // Offset from boot so it never competes with the traffic spike of a restart.
  setTimeout(tick, 60_000).unref?.()
}
