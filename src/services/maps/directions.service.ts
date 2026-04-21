import { ComputeDirectionsInput } from '../../schema/maps/directions.schema.js'
import { DirectionsResult } from '../../types/maps/directions.types.js'

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY!
const ROUTES_API_URL  = 'https://routes.googleapis.com/directions/v2:computeRoutes'

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

export async function computeDirectionsService(
  payload: ComputeDirectionsInput
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
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   GOOGLE_MAPS_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  })

  const data = await response.json()

  if (!response.ok) {
    const message =
      data?.error?.message ?? data?.message ?? 'Google Routes API error'
    throw new DirectionsUpstreamError(message, response.status)
  }

  if (!data.routes?.length) {
    throw new Error('No routes returned from Google Routes API')
  }

  return { routes: data.routes }
}

export class DirectionsUpstreamError extends Error {
  constructor(
    message: string,
    public readonly upstreamStatus: number
  ) {
    super(message)
    this.name = 'DirectionsUpstreamError'
  }
}