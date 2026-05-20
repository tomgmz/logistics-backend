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

async function getAccessToken(): Promise<string> {
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
      private_key:  process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const client        = await auth.getClient()
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

  // Time horizon in PHT (UTC+8). Google requires an explicit global window that
  // contains all vehicle/shipment time windows; the API default is anchored to
  // request time and rejects windows that fall outside it.
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

  // DRIVING costs for reordering only; map lines belong to Directions API on the client.
  // No startTimeWindows: avoids infeasible single-day departure squeezes for long PH legs.
  const vehicles = [{
    label:          'truck_1',
    travelMode:     'DRIVING' as const,
    routeModifiers: { avoidFerries: false },
    startLocation:  { latitude: origin.latitude, longitude: origin.longitude },
    endLocation:    { latitude: origin.latitude, longitude: origin.longitude },
    // Prefer minimizing road distance (full tour incl. return to depot). Without
    // explicit costs, the API still optimizes, but this matches “shortest route” intuition.
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
      })

    const drivingBody = {
      model,
      useGeodesicDistances: false,
      // Future schedule_date: traffic is not meaningful; avoids extra routing constraints.
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

  return {
    wasOptimized: true,
    stops: visits.map((visit, index) => {
      const shipmentIndex = parseInt(visit.shipmentLabel.replace('shipment_', ''))
      const destination   = destinations[shipmentIndex]
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
): Promise<Array<{ address: string; optimized_sequence_order: number }>> {
  const input: OptimizationDestination[] = destinations.map((d, i) => ({
    destination_id: String(i),
    address:        d.address,
    latitude:       d.latitude,
    longitude:      d.longitude,
  }))

  const { stops: optimizedStops } = await callOptimizationAPI(origin, input, scheduleDate, callTime)

  return optimizedStops.map((stop) => ({
    address:                  stop.address,
    optimized_sequence_order: stop.optimized_sequence_order,
  }))
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
