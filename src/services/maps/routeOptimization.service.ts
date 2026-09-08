import { GoogleAuth } from 'google-auth-library'
import axios from 'axios'
import { RouteOptimizationModel } from '../../models/maps/routeOptimization.model.js'
import {
  OptimizationDestination,
  OptimizedStop,
  OptimizeRouteResponse,
  GeocodeResult,
} from '../../types/maps/routeOptimization.types.js'

/**
 * Route Optimization (`optimizeTours`) is used only to choose stop order using
 * Google’s road-network travel estimates. We do not request polylines or map
 * geometry here; the app should draw routes with the Directions API (or Routes
 * API) using origin + the optimized waypoint order returned from this service.
 */

const GOOGLE_API_KEY    = process.env.GOOGLE_MAPS_API_KEY!
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID!
const GEOCODING_URL     = 'https://maps.googleapis.com/maps/api/geocode/json'

/**
 * How long we are prepared to wait on Google, in milliseconds.
 *
 * Axios has NO default timeout: without this a hung Google request hangs the
 * caller with it, forever. Optimisation improves stop order — it is never a
 * precondition for booking — so it is better to give up quickly and keep the
 * client's own ordering than to wait indefinitely for a better one.
 */
const GOOGLE_TIMEOUT_MS = 8_000

/**
 * One auth client for the process, not one per booking.
 *
 * This used to build a fresh `GoogleAuth` on every call, throwing away the
 * library's own token cache each time and paying for a JWT exchange per booking
 * (measured at ~400 ms cold, ~55 ms warm, all of it avoidable). The client
 * refreshes its own token, so it is built once, lazily.
 */
let authClientPromise: Promise<Awaited<ReturnType<GoogleAuth['getClient']>>> | null = null

function googleAuthClient() {
  if (!authClientPromise) {
    const auth = new GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
        private_key:  process.env.GOOGLE_PRIVATE_KEY!.replace(/\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    // A failed build must not stay cached, or the process never recovers from a
    // transient credential error.
    authClientPromise = auth.getClient().catch((err) => {
      authClientPromise = null
      throw err
    })
  }
  return authClientPromise
}

async function getAccessToken(): Promise<string> {
  const client        = await googleAuthClient()
  const tokenResponse = await client.getAccessToken()
  if (!tokenResponse.token) throw new Error('Failed to get Google access token')
  return tokenResponse.token
}

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const response = await axios.get(GEOCODING_URL, {
    params: {
      address:    `${address}, Philippines`,
      key:        GOOGLE_API_KEY,
      region:     'PH',
      components: 'country:PH',
    },
    timeout: GOOGLE_TIMEOUT_MS,
  })
  const results = response.data.results
  if (!results || results.length === 0) {
    throw new Error(`Could not geocode address: ${address}`)
  }
  const { lat, lng } = results[0].geometry.location
  return { address, latitude: lat, longitude: lng }
}

async function callOptimizationAPI(
  origin: { latitude: number; longitude: number },
  destinations: OptimizationDestination[],
  scheduleDate: string,
  _callTime: string,
): Promise<{ stops: OptimizedStop[]; wasOptimized: boolean }> {

  const accessToken = await getAccessToken()

  const dayStartPht = new Date(`${scheduleDate}T00:00:00+08:00`)
  const windowEndInclusive = new Date(`${scheduleDate}T23:59:59+08:00`)

  const globalStartTime = dayStartPht.toISOString()
  const planningHorizonDays = 7
  const globalEndTime = new Date(
    windowEndInclusive.getTime() + planningHorizonDays * 86400 * 1000,
  ).toISOString()

  const shipments = destinations.map((dest, index) => ({
    label: `shipment_${index}`,
    deliveries: [{
      label:           `dropoff_${index}`,
      arrivalLocation: { latitude: dest.latitude, longitude: dest.longitude },
      duration:        '300s', // 5 min service time per stop
    }],
  }))

  const vehicles = [{
    label:          'truck_1',
    travelMode:     'DRIVING' as const,
    routeModifiers: { avoidFerries: false },
    startLocation:  { latitude: origin.latitude, longitude: origin.longitude },
    endLocation:    { latitude: origin.latitude, longitude: origin.longitude },
    costPerKilometer: 1,
  }]

  const model = {
    globalStartTime,
    globalEndTime,
    shipments,
    vehicles,
  }

  const url = `https://routeoptimization.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}:optimizeTours`

  let routes: unknown[] = []

  try {
    const run = async (body: Record<string, unknown>) =>
      axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: GOOGLE_TIMEOUT_MS,
      })

    const drivingBody = {
      model,
      useGeodesicDistances: false,
      considerRoadTraffic: false,
    }

    let response = await run(drivingBody)
    routes = response.data.routes ?? []

    const visitsDriving =
      (routes[0] as { visits?: { shipmentLabel: string }[] })?.visits ?? []

    if (visitsDriving.length === 0 && destinations.length > 0) {
      console.warn(
        '[callOptimizationAPI] Driving optimization returned no visits (e.g. disconnected matrix); retrying with geodesic fallback for stop order only.',
      )
      response = await run({
        model,
        useGeodesicDistances:    true,
        geodesicMetersPerSecond: 11.11,
        considerRoadTraffic:     false,
      })
      routes = response.data.routes ?? []
    }

    console.log('[callOptimizationAPI] routes:', JSON.stringify(response.data.routes ?? []))
    console.log('[callOptimizationAPI] skippedShipments:', JSON.stringify(response.data.skippedShipments ?? []))
  } catch (err) {
    console.warn('[callOptimizationAPI] Google API call failed, using original order:', (err as any).response?.data ?? err)
  }

  const visits: { shipmentLabel: string }[] =
    (routes[0] as { visits?: { shipmentLabel: string }[] })?.visits ?? []

  if (visits.length === 0) {
    console.warn('[callOptimizationAPI] No visits returned, using original destination order')
    return {
      wasOptimized: false,
      stops: destinations.map((dest, index) => ({
        destination_id:           dest.destination_id,
        address:                  dest.address,
        latitude:                 dest.latitude,
        longitude:                dest.longitude,
        optimized_sequence_order: index + 1,
        status:                   dest.status ?? 'pending',
        notes:                    dest.notes  ?? null,
      })),
    }
  }

  // Google can decline to route a shipment (`skippedShipments` — an unreachable
  // point, an infeasible window). Those used to fall out of the returned list
  // entirely, so the caller silently lost a drop-off, or that stop kept its
  // original number and collided with one that had been renumbered. Visited
  // stops take the optimised order; anything skipped is appended in its original
  // relative order, so every stop comes back exactly once.
  const visited = visits
    .map((visit) => parseInt(visit.shipmentLabel.replace('shipment_', ''), 10))
    .filter((i) => Number.isInteger(i) && i >= 0 && i < destinations.length)

  const seen    = new Set(visited)
  const skipped = destinations.map((_, i) => i).filter((i) => !seen.has(i))

  if (skipped.length > 0) {
    console.warn(
      `[callOptimizationAPI] ${skipped.length} shipment(s) not routed by Google; ` +
      'appending them in their original order.',
    )
  }

  return {
    wasOptimized: true,
    stops: [...visited, ...skipped].map((destinationIndex, index) => {
      const destination = destinations[destinationIndex]
      return {
        destination_id:           destination.destination_id,
        address:                  destination.address,
        latitude:                 destination.latitude,
        longitude:                destination.longitude,
        optimized_sequence_order: index + 1,
        status:                   destination.status ?? 'pending',
        notes:                    destination.notes  ?? null,
      }
    }),
  }
}

/**
 * Optimised stop order for a list of destinations, keyed by their POSITION in
 * the list the caller passed in.
 *
 * It used to answer with the stop's address, and the caller matched results back
 * by string. Two drop-offs at the same address — one warehouse, two deliveries,
 * entirely normal for FMCG — then matched the same result and collapsed onto a
 * single position, and a stop Google had skipped matched nothing at all and kept
 * a number that had since been handed to another stop. The index is the only
 * identifier here that is guaranteed unique, so it is what comes back.
 */
export async function optimizeDestinationsService(
  origin: { latitude: number; longitude: number },
  destinations: Array<{
    address: string
    latitude: number
    longitude: number
    sequence_order: number
  }>,
  scheduleDate: string,
  callTime: string,
): Promise<Array<{ index: number; optimized_sequence_order: number }>> {
  const input: OptimizationDestination[] = destinations.map((d, i) => ({
    destination_id: String(i),
    address:        d.address,
    latitude:       d.latitude,
    longitude:      d.longitude,
  }))

  const { stops: optimizedStops } = await callOptimizationAPI(origin, input, scheduleDate, callTime)

  return optimizedStops
    .map((stop) => ({
      index:                    parseInt(stop.destination_id, 10),
      optimized_sequence_order: stop.optimized_sequence_order,
    }))
    .filter((s) => Number.isInteger(s.index) && s.index >= 0 && s.index < destinations.length)
}

export async function optimizeBookingRouteService(
  bookingId: string
): Promise<OptimizeRouteResponse> {
  const booking = await RouteOptimizationModel.getBookingWithDestinations(bookingId)

  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  if (!booking.booking_destinations || booking.booking_destinations.length === 0) {
    throw new Error('Booking has no destinations to optimize')
  }

  if (booking.status === 'completed' || booking.status === 'cancelled') {
    throw new Error(`Cannot optimize a ${booking.status} booking`)
  }

  let originCoords = {
    latitude:  booking.origin_latitude  as number,
    longitude: booking.origin_longitude as number,
  }

  if (!originCoords.latitude || !originCoords.longitude) {
    const geocoded = await geocodeAddress(booking.origin)
    originCoords   = { latitude: geocoded.latitude, longitude: geocoded.longitude }
    await RouteOptimizationModel.saveOriginCoordinates(bookingId, geocoded.latitude, geocoded.longitude)
  }

  const destinations: OptimizationDestination[] = await Promise.all(
    booking.booking_destinations.map(async (dest: {
      destination_id: string
      address: string
      latitude: number | null
      longitude: number | null
      status: 'pending' | 'delivered' | 'failed'
      notes: string | null
    }) => {
      let coords = { latitude: dest.latitude, longitude: dest.longitude }

      if (!coords.latitude || !coords.longitude) {
        const geocoded = await geocodeAddress(dest.address)
        coords = { latitude: geocoded.latitude, longitude: geocoded.longitude }
        await RouteOptimizationModel.saveDestinationCoordinates(dest.destination_id, geocoded.latitude, geocoded.longitude)
      }

      if (!coords.latitude || !coords.longitude) {
        throw new Error(`Could not resolve coordinates for: ${dest.address}`)
      }

      return {
        destination_id: dest.destination_id,
        address:        dest.address,
        latitude:       coords.latitude  as number,
        longitude:      coords.longitude as number,
        status:         dest.status,
        notes:          dest.notes,
      }
    })
  )

  const { stops: optimizedStops, wasOptimized } = await callOptimizationAPI(
    originCoords,
    destinations,
    booking.schedule_date as string,
    booking.call_time     as string,
  )

  if (!wasOptimized) {
    console.warn(`[optimizeBookingRouteService] Fell back to original order for booking ${bookingId}`)
  }

  await RouteOptimizationModel.saveOptimizedOrder(optimizedStops)

  return {
    booking_id:      bookingId,
    origin:          { address: booking.origin, ...originCoords },
    optimized_stops: optimizedStops,
    total_stops:     optimizedStops.length,
  }
}

export async function getOptimizedRouteService(
  bookingId: string
): Promise<OptimizeRouteResponse> {
  const booking = await RouteOptimizationModel.getBookingWithDestinations(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  let originLat  = booking.origin_latitude  as number | null
  let originLng  = booking.origin_longitude as number | null

  if (!originLat || !originLng) {
    const geocoded = await geocodeAddress(booking.origin)
    originLat = geocoded.latitude
    originLng = geocoded.longitude
    await RouteOptimizationModel.saveOriginCoordinates(bookingId, originLat, originLng)
  }

  const stops: OptimizedStop[] = (booking.booking_destinations ?? [])
    .sort((a: { sequence_order: number }, b: { sequence_order: number }) =>
      a.sequence_order - b.sequence_order
    )
    .map((dest: {
      destination_id: string
      address: string
      latitude: number | null
      longitude: number | null
      sequence_order: number
      status: 'pending' | 'delivered' | 'failed'
      notes: string | null
    }) => {
      if (dest.latitude == null || dest.longitude == null) {
        throw new Error(`Destination ${dest.destination_id} is missing coordinates — re-run optimization`)
      }
      return {
        destination_id:           dest.destination_id,
        address:                  dest.address,
        latitude:                 dest.latitude,
        longitude:                dest.longitude,
        optimized_sequence_order: dest.sequence_order,
        status:                   dest.status,
        notes:                    dest.notes ?? null,
      }
    })

  return {
    booking_id:  bookingId,
    origin: {
      address:   booking.origin,
      latitude:  originLat,
      longitude: originLng,
    },
    optimized_stops: stops,
    total_stops:     stops.length,
  }
}

export async function geocodeAddressService(address: string): Promise<GeocodeResult> {
  return geocodeAddress(address)
}
