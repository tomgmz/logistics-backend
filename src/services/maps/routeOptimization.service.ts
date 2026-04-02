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
  const accessToken = await getAccessToken()

  const shipments = destinations.map((dest, index) => ({
    label: `shipment_${index}`,
    deliveries: [{
      label: `dropoff_${index}`,
      arrivalLocation: { latitude: dest.latitude, longitude: dest.longitude },
    }],
  }))

  const vehicles = [{
    label: 'truck_1',
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
      notes:                    destination.notes ?? null,
    }
  })
}

// Called on booking creation AND when admin explicitly re-optimizes
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

  // Geocode origin only if coordinates are missing (won't happen after initial creation)
  let originCoords = {
    latitude:  booking.origin_latitude  as number,
    longitude: booking.origin_longitude as number,
  }

  if (!originCoords.latitude || !originCoords.longitude) {
    const geocoded = await geocodeAddress(booking.origin)
    originCoords   = { latitude: geocoded.latitude, longitude: geocoded.longitude }
    await RouteOptimizationModel.saveOriginCoordinates(bookingId, geocoded.latitude, geocoded.longitude)
  }

  // Geocode each destination only if coordinates are missing
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

  const optimizedStops = await callOptimizationAPI(originCoords, destinations)

  // Persist optimized sequence_order
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
    booking_id:      bookingId,
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