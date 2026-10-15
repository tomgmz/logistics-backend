import { PlacesAutocompleteInput, PlaceDetailsInput } from '../../schema/maps/places.schema.js'
import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from '../../lib/log-system.js'

/**
 * Google Places (New) for the driver app's browse map.
 *
 * The web booking form calls Places from the browser with its own key; the
 * mobile app's key is restricted to the native Maps SDK, so the app searches
 * through here instead — the same way it gets directions.
 *
 * Results are limited to the Philippines, like the web form.
 */

const GOOGLE_MAPS_KEY  = process.env.GOOGLE_MAPS_API_KEY!
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete'
const DETAILS_URL      = 'https://places.googleapis.com/v1/places'
const SOURCE           = 'google-maps.places'
// Bias, not a fence: a farther match still shows, just lower down.
const BIAS_RADIUS_M    = 50_000

export interface PlaceSuggestion {
  placeId:   string
  label:     string
  primary:   string
  secondary: string
}

export interface ResolvedPlace {
  placeId:   string
  address:   string
  latitude:  number
  longitude: number
}

export class PlacesUpstreamError extends Error {
  constructor(message: string, public upstreamStatus: number) {
    super(message)
  }
}

function fail(status: number, message: string): never {
  logSystemThrottled(SOURCE, EXTERNAL_FAILURE_LOG_WINDOW_MS, {
    log_level:  'error',
    event_type: 'external_api',
    source:     SOURCE,
    message:    `Places request failed: ${message}`,
    metadata:   { status },
  })
  // Google's 4xx are about our request or key, not the caller's — never echo
  // them back as the caller's fault.
  throw new PlacesUpstreamError('Place search is unavailable right now.', 502)
}

export async function autocompletePlaces(input: PlacesAutocompleteInput): Promise<PlaceSuggestion[]> {
  const body = {
    input:               input.input,
    includedRegionCodes: ['ph'],
    ...(input.sessionToken && { sessionToken: input.sessionToken }),
    ...(input.near && {
      locationBias: { circle: { center: input.near, radius: BIAS_RADIUS_M } },
    }),
  }

  const res = await fetch(AUTOCOMPLETE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
    body:    JSON.stringify(body),
  }).catch((err: Error) => fail(0, err.message))

  const data = await res.json().catch(() => ({}))
  if (!res.ok) fail(res.status, data?.error?.message ?? String(res.status))

  return (data.suggestions ?? [])
    .map((s: any) => s.placePrediction)
    .filter((p: any) => p?.placeId)
    .map((p: any) => ({
      placeId:   p.placeId,
      label:     p.text?.text ?? '',
      primary:   p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
      secondary: p.structuredFormat?.secondaryText?.text ?? '',
    }))
}

export async function placeDetails(input: PlaceDetailsInput): Promise<ResolvedPlace> {
  const url = new URL(`${DETAILS_URL}/${encodeURIComponent(input.placeId)}`)
  if (input.sessionToken) url.searchParams.set('sessionToken', input.sessionToken)

  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key':   GOOGLE_MAPS_KEY,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
    },
  }).catch((err: Error) => fail(0, err.message))

  const data = await res.json().catch(() => ({}))
  if (!res.ok) fail(res.status, data?.error?.message ?? String(res.status))
  if (data.location?.latitude == null || data.location?.longitude == null) {
    throw new PlacesUpstreamError('That place has no location on the map.', 404)
  }

  // Same address shape as the web picker: drop a leading plus code, and lead
  // with the place's name when the address doesn't already say it.
  const name    = data.displayName?.text ?? ''
  const address = String(data.formattedAddress ?? '').replace(/^[A-Z0-9]{4}\+[A-Z0-9]{2,3},\s*/, '')

  return {
    placeId:   data.id ?? input.placeId,
    address:   name && !address.toLowerCase().includes(name.toLowerCase())
      ? `${name}, ${address}`
      : address || name,
    latitude:  data.location.latitude,
    longitude: data.location.longitude,
  }
}
