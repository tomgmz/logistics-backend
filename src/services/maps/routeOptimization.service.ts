import { GoogleAuth } from 'google-auth-library'
import axios from 'axios'
import { RouteOptimizationModel } from '../../models/maps/routeOptimization.model.js'
import {
  OptimizationDestination,
  OptimizedStop,
  OptimizeRouteResponse,
  GeocodeResult,
} from '../../types/maps/routeOptimization.types.js'

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
  destinations: OptimizationDestination[]
): Promise<OptimizedStop[]> {

  console.log('[optimize] getting access token...')
  const accessToken = await getAccessToken()
  console.log('[optimize] token OK, calling optimization API...')

  const shipments = destinations.map((dest, index) => ({
    label: `shipment_${index}`,
    deliveries: [{
      label:           `dropoff_${index}`,
      arrivalLocation: { latitude: dest.latitude, longitude: dest.longitude },
    }],
  }))

  const vehicles = [{
    label:         'truck_1',
    startLocation: { latitude: origin.latitude, longitude: origin.longitude },
  }]

  const response = await axios.post(
    `https://routeoptimization.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}:optimizeTours`,
    { model: { shipments, vehicles } },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${accessToken}`,
      },
    }
  )

  console.log('[optimize] API response:', JSON.stringify(response.data, null, 2))

  const routes = response.data.routes
  if (!routes || routes.length === 0) {
    throw new Error('No optimized route returned from Google')
  }

  return routes[0].visits.map((visit: { shipmentLabel: string }, index: number) => {
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
  })
}

export async function optimizeDestinationsService(
  origin: { latitude: number; longitude: number },
  destinations: Array<{
    address: string
    latitude: number
    longitude: number
    sequence_order: number
  }>
): Promise<Array<{ address: string; optimized_sequence_order: number }>> {
  const input: OptimizationDestination[] = destinations.map((d, i) => ({
    destination_id: String(i),
    address:        d.address,
    latitude:       d.latitude,
    longitude:      d.longitude,
  }))

  const optimizedStops = await callOptimizationAPI(origin, input)

  return optimizedStops.map((stop) => ({
    address:                  stop.address,
    optimized_sequence_order: stop.optimized_sequence_order,
  }))
}

export async function optimizeBookingRouteService(
  bookingId: string
): Promise<OptimizeRouteResponse> {
  console.log('[optimize] 1 — fetching booking:', bookingId)
  const booking = await RouteOptimizationModel.getBookingWithDestinations(bookingId)

  console.log('[optimize] 2 — booking found:', !!booking, '| status:', booking?.status)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  console.log('[optimize] 3 — destinations count:', booking.booking_destinations?.length)
  if (!booking.booking_destinations || booking.booking_destinations.length === 0) {
    throw new Error('Booking has no destinations to optimize')
  }

  console.log('[optimize] 4 — status check:', booking.status)
  if (booking.status === 'completed' || booking.status === 'cancelled') {
    throw new Error(`Cannot optimize a ${booking.status} booking`)
  }

  let originCoords = {
    latitude:  booking.origin_latitude  as number,
    longitude: booking.origin_longitude as number,
  }

  console.log('[optimize] 5 — origin coords:', originCoords)
  if (!originCoords.latitude || !originCoords.longitude) {
    console.log('[optimize] 5a — geocoding origin:', booking.origin)
    const geocoded = await geocodeAddress(booking.origin)
    originCoords   = { latitude: geocoded.latitude, longitude: geocoded.longitude }
    await RouteOptimizationModel.saveOriginCoordinates(bookingId, geocoded.latitude, geocoded.longitude)
    console.log('[optimize] 5b — origin geocoded:', originCoords)
  }

  console.log('[optimize] 6 — resolving destination coords...')
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
        console.log('[optimize] 6a — geocoding dest:', dest.address)
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

  console.log('[optimize] 7 — calling optimization API with', destinations.length, 'destinations')
  const optimizedStops = await callOptimizationAPI(originCoords, destinations)

  console.log('[optimize] 8 — saving optimized order...')
  await RouteOptimizationModel.saveOptimizedOrder(optimizedStops)

  console.log('[optimize] 9 — done')
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

  if (!booking.origin_latitude || !booking.origin_longitude) {
    throw new Error('Origin coordinates not found — booking may not have been optimized yet')
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
        throw new Error(`Destination ${dest.destination_id} is missing coordinates`)
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
      latitude:  booking.origin_latitude,
      longitude: booking.origin_longitude,
    },
    optimized_stops: stops,
    total_stops:     stops.length,
  }
}

export async function geocodeAddressService(address: string): Promise<GeocodeResult> {
  return geocodeAddress(address)
}