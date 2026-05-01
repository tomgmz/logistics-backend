import { ComputeDirectionsInput } from '../../schema/maps/directions.schema.js'
import { DirectionsResult }       from '../../types/maps/directions.types.js'

const GOOGLE_MAPS_KEY  = process.env.GOOGLE_MAPS_API_KEY!
const MAPBOX_TOKEN     = process.env.MAPBOX_ACCESS_TOKEN!
const ROUTES_API_URL   = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const MAP_MATCH_URL    = 'https://api.mapbox.com/matching/v5/mapbox/driving'

const FIELD_MASK = [
  'routes.polyline.encodedPolyline',
  'routes.duration',
  'routes.staticDuration',
  'routes.distanceMeters',
  'routes.legs.duration',
  'routes.legs.staticDuration',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.localizedValues',
  'routes.legs.steps.startLocation',
  'routes.travelAdvisory.speedReadingIntervals',
].join(',')

function decodePolyline(encoded: string): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = []
  let index = 0, lat = 0, lng = 0
  while (index < encoded.length) {
    let shift = 0, result = 0, byte: number
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5 }
    while (byte >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    shift = 0; result = 0
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5 }
    while (byte >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 })
  }
  return points
}

type Point = { latitude: number; longitude: number }

function haversine(a: Point, b: Point): number {
  const R     = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat  = toRad(b.latitude  - a.latitude)
  const dLng  = toRad(b.longitude - a.longitude)
  const s     = Math.sin(dLat / 2)
  const g     = Math.sin(dLng / 2)
  return 2 * R * Math.asin(
    Math.sqrt(s * s + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * g * g),
  )
}

function bearing(a: Point, b: Point): number {
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180
  const lat1 = (a.latitude  * Math.PI) / 180
  const lat2 = (b.latitude  * Math.PI) / 180
  const y    = Math.sin(dLng) * Math.cos(lat2)
  const x    = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (Math.atan2(y, x) * 180) / Math.PI
}

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

/**
 * Keeps points where the road curves (angle threshold) OR where the
 * gap since the last kept point exceeds maxGapMeters (straight roads).
 * This prevents Map Matching from guessing wrong on long straights.
 */
function sampleByAngleAndDistance(
  points: Point[],
  maxPoints  = 98,
  angleDeg   = 8,
  maxGapMeters = 50,
): Point[] {
  if (points.length <= maxPoints) return points

  const result: Point[] = [points[0]]
  let prevBearing = bearing(points[0], points[1])
  let lastKept    = points[0]

  for (let i = 1; i < points.length - 1; i++) {
    const b    = bearing(points[i], points[i + 1])
    const dist = haversine(lastKept, points[i])

    if (angleDiff(b, prevBearing) >= angleDeg || dist >= maxGapMeters) {
      result.push(points[i])
      prevBearing = b
      lastKept    = points[i]
    }
  }

  result.push(points[points.length - 1])

  // If still over limit, thin evenly while preserving first + last
  if (result.length > maxPoints) {
    const step = Math.ceil(result.length / maxPoints)
    return [
      result[0],
      ...result.slice(1, -1).filter((_, i) => i % step === 0),
      result[result.length - 1],
    ]
  }

  return result
}

async function snapPolylineToMapbox(
  points: Point[],
): Promise<Point[] | null> {
  try {
    const sampled = sampleByAngleAndDistance(points, 98, 8, 50)

    const coords  = sampled.map((p) => `${p.longitude},${p.latitude}`).join(';')
    // 25m radius gives Map Matching enough room to find the correct
    // road centerline without snapping to a parallel service road
    const radii   = sampled.map(() => 25).join(';')
    const url     = `${MAP_MATCH_URL}/${coords}?access_token=${MAPBOX_TOKEN}&geometries=geojson&tidy=true&overview=full&radiuses=${radii}`

    const res  = await fetch(url)
    const data = await res.json()

    if (!res.ok || !data.matchings?.[0]) {
      console.warn('[map-match] Mapbox snap failed:', data.message ?? res.status)
      return null
    }

    return (data.matchings[0].geometry.coordinates as [number, number][]).map(
      ([lng, lat]) => ({ latitude: lat, longitude: lng }),
    )
  } catch (err) {
    console.warn('[map-match] Snap error, falling back to Google polyline:', err)
    return null
  }
}

export async function computeDirectionsService(
  payload: ComputeDirectionsInput,
): Promise<DirectionsResult> {
  const body = {
    ...payload,
    extraComputations: [
      ...new Set([
        ...((payload as any).extraComputations ?? []),
        'TRAFFIC_ON_POLYLINE',
      ]),
    ],
  }

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
    const message = data?.error?.message ?? data?.message ?? 'Google Routes API error'
    throw new DirectionsUpstreamError(message, response.status)
  }

  if (!data.routes?.length) {
    throw new Error('No routes returned from Google Routes API')
  }

  const route  = data.routes[0]
  const points = decodePolyline(route.polyline.encodedPolyline)

  const snapped = await snapPolylineToMapbox(points)
  console.log('[snap] result:', snapped ? `✓ ${snapped.length} points` : '✗ null — falling back to Google polyline')
  if (snapped) {
    route.polyline._snappedCoords = snapped

    // Remap speed interval indices proportionally to the snapped point count
    const ratio     = snapped.length / points.length
    const intervals = route.travelAdvisory?.speedReadingIntervals
    if (intervals?.length) {
      route.travelAdvisory.speedReadingIntervals = intervals.map((iv: any) => ({
        ...iv,
        startPolylinePointIndex: Math.round((iv.startPolylinePointIndex ?? 0) * ratio),
        endPolylinePointIndex:   Math.round((iv.endPolylinePointIndex   ?? points.length - 1) * ratio),
      }))
    }
  }

  return { routes: data.routes }
}

export class DirectionsUpstreamError extends Error {
  constructor(
    message: string,
    public readonly upstreamStatus: number,
  ) {
    super(message)
    this.name = 'DirectionsUpstreamError'
  }
}