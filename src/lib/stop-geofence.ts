/**
 * How close the driver has to be to confirm a stop.
 *
 * A proof photo shows the load; it does not show where the load was. Without a
 * position check a stop can be marked done from anywhere — the yard, the next
 * town, the driver's house — and the record looks identical to one confirmed at
 * the gate. This is the check that makes those two different.
 *
 * It is not fraud-proof: a determined driver can feed the phone a false
 * position. There is no "confirm anyway" from the app; the office confirms a
 * step the driver can't (Booking Management, reason required).
 */

/** Metres. A driver can't confirm a stop further out than this. */
export const STOP_PROOF_RADIUS_M = 100

/** Earth's mean radius in metres, for the haversine below. */
const EARTH_RADIUS_M = 6_371_008.8

export interface Coordinates {
  latitude:  number
  longitude: number
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a flat-earth approximation: the error of treating
 * degrees as a grid is small at these distances but grows with latitude, and
 * this is a gate people are refused by — it should not be looser in Manila than
 * in Baguio.
 */
export function distanceInMetres(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude)
  const dLon = toRadians(b.longitude - a.longitude)
  const lat1 = toRadians(a.latitude)
  const lat2 = toRadians(b.latitude)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** A stop's own coordinates, as they come off a `numeric` column. */
export function stopCoordinates(
  latitude:  number | string | null | undefined,
  longitude: number | string | null | undefined,
): Coordinates | null {
  const lat = latitude  == null ? NaN : Number(latitude)
  const lon = longitude == null ? NaN : Number(longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { latitude: lat, longitude: lon }
}

export interface StopProofPosition extends Coordinates {
  /** The phone's own estimate of its error, in metres, when it reported one. */
  accuracy_m?: number | null
}

export interface GeofenceOutcome {
  /** Null when the stop has no coordinates to measure against. */
  distance_m: number | null
  /**
   * Always null for a driver's confirmation: drivers can no longer confirm from
   * outside the radius with a reason (removed 2026-11-14, it was for testing).
   * The office's own confirmations still record their reason here.
   */
  override_reason: string | null
}

/**
 * Decide whether this confirmation may stand.
 *
 * Throws when the position can't be read or the driver is outside the radius;
 * there is no way past it from the app. A driver who really is at the stop with
 * no usable GPS (inside a dock) asks the office, which confirms the step from
 * Booking Management with its own reason.
 *
 * A stop with no coordinates cannot be measured — older bookings predate
 * geocoding — and is allowed rather than blocked: refusing a delivery over
 * missing reference data punishes the driver for the office's gap.
 */
export function assertStopProximity(
  stop:      Coordinates | null,
  position:  StopProofPosition | null | undefined,
  stopLabel: string,
): GeofenceOutcome {
  // No fix at all. An app that never sends a position is refused for the same
  // reason: silence must not become the way past the check.
  if (!position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)) {
    throw new StopTooFarError(
      `Your location could not be read, so this ${stopLabel} cannot be confirmed. Turn location on and try again, or ask the office to confirm it.`,
      null,
    )
  }

  if (!stop) return { distance_m: null, override_reason: null }

  const distance = Math.round(distanceInMetres(stop, position))
  if (distance > STOP_PROOF_RADIUS_M) {
    throw new StopTooFarError(
      `You are about ${distance} m from the ${stopLabel}. Move within ${STOP_PROOF_RADIUS_M} m to confirm it.`,
      distance,
    )
  }
  return { distance_m: distance, override_reason: null }
}

/**
 * Raised when a stop is confirmed too far away, or with no position.
 *
 * Its own type so the route can answer 422 — the request was well-formed and
 * the driver is who they say they are; it is the position that is wrong, and
 * the app has to tell them so rather than showing a generic failure.
 */
export class StopTooFarError extends Error {
  /** Null when there was no position to measure at all. */
  readonly distance_m: number | null

  constructor(message: string, distanceM: number | null) {
    super(message)
    this.name = 'StopTooFarError'
    this.distance_m = distanceM
  }
}
