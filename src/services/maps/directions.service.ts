import { ComputeDirectionsInput } from '../../schema/maps/directions.schema.js'
import { DirectionsResult }       from '../../types/maps/directions.types.js'

const GOOGLE_MAPS_KEY  = process.env.GOOGLE_MAPS_API_KEY!
const ROUTES_API_URL   = 'https://routes.googleapis.com/directions/v2:computeRoutes'

const ROADS_SNAP_URL   = 'https://roads.googleapis.com/v1/snapToRoads'

const FIELD_MASK = [
  'routes.polyline.encodedPolyline',
  'routes.duration',
  'routes.staticDuration',
  'routes.distanceMeters',
  'routes.description',
  'routes.routeLabels',
  'routes.routeToken',
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

function sampleByAngleAndDistance(
  points: Point[],
  maxPoints    = 98,
  angleDeg     = 5,
  maxGapMeters = 200,
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

// Google Roads "Snap to Roads" accepts at most 100 points per request.
const ROADS_MAX_POINTS = 100

async function snapPolylineToGoogleRoads(points: Point[]): Promise<Point[] | null> {
  try {
    // Keep the trace within the 100-point cap; interpolate=true then re-densifies
    // the result so the rendered line stays smooth between sampled points.
    const sampled = sampleByAngleAndDistance(points, ROADS_MAX_POINTS, 5, 200)
    const path    = sampled.map((p) => `${p.latitude},${p.longitude}`).join('|')
    const url     = `${ROADS_SNAP_URL}?interpolate=true&path=${encodeURIComponent(path)}&key=${GOOGLE_MAPS_KEY}`

    const res  = await fetch(url)
    const data = await res.json()

    if (!res.ok || !data.snappedPoints?.length) {
      console.warn('[snap] Google Roads snap failed:', data?.error?.message ?? res.status)
      return null
    }

    return (data.snappedPoints as Array<{ location: { latitude: number; longitude: number } }>).map(
      (sp) => ({ latitude: sp.location.latitude, longitude: sp.location.longitude }),
    )
  } catch (err) {
    console.warn('[snap] Google Roads snap error, falling back to Google polyline:', err)
    return null
  }
}

function encodePolyline(points: Point[]): string {
  let prevLat = 0, prevLng = 0
  let result  = ''

  const encodeValue = (value: number) => {
    let v = Math.round(value * 1e5)
    v = v < 0 ? ~(v << 1) : v << 1
    while (v >= 0x20) {
      result += String.fromCharCode((0x20 | (v & 0x1f)) + 63)
      v >>= 5
    }
    result += String.fromCharCode(v + 63)
  }

  for (const point of points) {
    encodeValue(point.latitude  - prevLat)
    encodeValue(point.longitude - prevLng)
    prevLat = point.latitude
    prevLng = point.longitude
  }

  return result
}

function buildStraightLineFallback(payload: ComputeDirectionsInput): DirectionsResult {
  const toPoint = (wp: ComputeDirectionsInput['origin']): Point => ({
    latitude:  wp.location.latLng.latitude,
    longitude: wp.location.latLng.longitude,
  })

  const allPoints: Point[] = [
    toPoint(payload.origin),
    ...((payload.intermediates ?? []).map(toPoint)),
    toPoint(payload.destination),
  ]

  const encodedPolyline = encodePolyline(allPoints)

  let totalMeters = 0
  for (let i = 0; i < allPoints.length - 1; i++) {
    totalMeters += haversine(allPoints[i], allPoints[i + 1])
  }
  const estimatedSeconds = Math.round(totalMeters / (50_000 / 3_600))
  const durationStr      = `${estimatedSeconds}s`

  const legs = allPoints.slice(0, -1).map((a, i) => {
    const legMeters  = haversine(a, allPoints[i + 1])
    const legSeconds = Math.round(legMeters / (50_000 / 3_600))
    return { duration: `${legSeconds}s`, staticDuration: `${legSeconds}s` }
  })

  return {
    routes: [{
      polyline:       { encodedPolyline },
      duration:       durationStr,
      staticDuration: durationStr,
      distanceMeters: Math.round(totalMeters),
      legs,
      travelAdvisory: { speedReadingIntervals: [] },
    }],
  }
}

export async function computeDirectionsService(
  payload: ComputeDirectionsInput,
): Promise<DirectionsResult> {
  const { fast, ...routePayload } = payload as ComputeDirectionsInput & { fast?: boolean }

  // In fast mode (mobile re-routing) honor the client's request to skip the
  // costly traffic computation; otherwise always include it.
  const extraComputations = fast
    ? ((routePayload as any).extraComputations ?? [])
    : [
        ...new Set([
          ...((routePayload as any).extraComputations ?? []),
          'TRAFFIC_ON_POLYLINE',
        ]),
      ]

  const body = {
    ...routePayload,
    extraComputations,
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
    console.warn('[computeDirectionsService] No routes from Google, returning straight-line fallback')
    return buildStraightLineFallback(payload)
  }

  // Fast mode: the client uses the raw Google polyline, so skip the snap and
  // leave the traffic intervals (if any) in Google's own index space.
  if (fast) {
    return { routes: data.routes }
  }

  // Snap every returned route to road centerlines. With computeAlternativeRoutes
  // there are several; each is snapped independently so the driver's route picker
  // renders clean, road-aligned lines for all options. A failed snap on any one
  // route falls back to its raw Google polyline.
  await Promise.all(
    (data.routes as any[]).map(async (route, i) => {
      const points  = decodePolyline(route.polyline.encodedPolyline)
      const snapped = await snapPolylineToGoogleRoads(points)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[snap] route ${i}:`, snapped ? `✓ ${snapped.length} points` : '✗ null — falling back to Google polyline')
      }
      if (!snapped) return

      route.polyline._snappedCoords = snapped

      const ratio     = snapped.length / points.length
      const intervals = route.travelAdvisory?.speedReadingIntervals
      if (intervals?.length) {
        route.travelAdvisory.speedReadingIntervals = intervals.map((iv: any) => ({
          ...iv,
          startPolylinePointIndex: Math.round((iv.startPolylinePointIndex ?? 0) * ratio),
          endPolylinePointIndex:   Math.round((iv.endPolylinePointIndex   ?? points.length - 1) * ratio),
        }))
      }
    }),
  )

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