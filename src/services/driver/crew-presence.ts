import { pool } from '../../lib/database.js'
import { distanceInMetres, type StopProofPosition } from '../../lib/stop-geofence.js'

/**
 * Is the confirming phone with the truck? (2026-11-21)
 *
 * Both drivers can confirm loading and drop-offs, but only one phone is the
 * truck's position (the navigating one, tracking.service). A confirmation from
 * the OTHER phone is checked against where the truck was at that moment: the
 * truck's recorded fixes from the other crew phone within ±3 minutes of the
 * confirmation. If there are such fixes and none is within 500 m of the
 * confirming phone, the phone was not in the truck (left at home, in another
 * vehicle, handed to someone else) and the confirmation goes to the office
 * instead of being recorded.
 *
 * Not a contradiction: no fixes in the window (no one was sharing location, or
 * both phones were offline), or no position from the confirming phone (the
 * 100 m stop check already handles that). 500 m matches the late-confirmation
 * trail check: phone GPS in a warehouse can be off by 100 m+, and the truck's
 * last fix can be up to a minute old while it parks.
 */
export const WITH_TRUCK_RADIUS_M = 500
export const WITH_TRUCK_WINDOW_MS = 3 * 60_000

export async function awayFromTruck(
  bookingId: string,
  driverId: string | null,
  position: StopProofPosition | null | undefined,
  atMs: number | null,
): Promise<{ away: boolean; distance_m: number | null }> {
  if (!driverId) return { away: false, distance_m: null }
  if (!position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)) {
    return { away: false, distance_m: null }
  }
  const at = atMs ?? Date.now()
  const { rows } = await pool.query<{ latitude: string; longitude: string }>(
    `SELECT latitude, longitude FROM driver_location_history
      WHERE booking_id = $1 AND driver_id <> $2 AND recorded_at BETWEEN $3 AND $4`,
    [bookingId, driverId, new Date(at - WITH_TRUCK_WINDOW_MS).toISOString(), new Date(at + WITH_TRUCK_WINDOW_MS).toISOString()],
  )
  if (!rows.length) return { away: false, distance_m: null }
  const nearest = Math.min(...rows.map((r) => distanceInMetres(position, { latitude: Number(r.latitude), longitude: Number(r.longitude) })))
  return { away: nearest > WITH_TRUCK_RADIUS_M, distance_m: Math.round(nearest) }
}
