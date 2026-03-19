import { RouteOptimizationClient } from '@googlemaps/routeoptimization'
import axios from 'axios'
import { RouteOptimizationModel } from '../../models/maps/routeOptimization.model.js'
import {
  OptimizationDestination,
  OptimizedStop,
  OptimizeRouteResponse,
  GeocodeResult,
} from '../../types/maps/routeOptimization.types.js'

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY!
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID!
const GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

console.log('GOOGLE_PROJECT_ID:', GOOGLE_PROJECT_ID)
console.log('GOOGLE_SERVICE_ACCOUNT_EMAIL:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL)
console.log('GOOGLE_PRIVATE_KEY exists:', !!process.env.GOOGLE_PRIVATE_KEY)
console.log('GOOGLE_PRIVATE_KEY starts with:', process.env.GOOGLE_PRIVATE_KEY?.substring(0, 40))

const routeOptimizationClient = new RouteOptimizationClient({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    private_key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  },
})

//GEOCODING

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const response = await axios.get(GEOCODING_URL, {
    params: {
      address: `${address}, Philippines`,
      key: GOOGLE_API_KEY,
    },
  })

  const results = response.data.results
  if (!results || results.length === 0) {
    throw new Error(`Could not geocode address: ${address}`)
  }

  const { lat, lng } = results[0].geometry.location
  return { address, latitude: lat, longitude: lng }
}

//ROUTE OPTIMIZATION

async function callOptimizationAPI(
  origin: { latitude: number; longitude: number },
  destinations: OptimizationDestination[]
): Promise<OptimizedStop[]> {

  const shipments = destinations.map((dest, index) => ({
    label: `shipment_${index}`,
    deliveries: [
      {
        label: `dropoff_${index}`,
        arrivalLocation: {
          latitude: dest.latitude,
          longitude: dest.longitude,
        },
      },
    ],
  }))

  const vehicles = [
    {
      label: 'truck_1',
      startLocation: {
        latitude: origin.latitude,
        longitude: origin.longitude,
      },
      endLocation: {
        latitude: origin.latitude,
        longitude: origin.longitude,
      },
    },
  ]

  const [response] = await routeOptimizationClient.optimizeTours({
    parent: `projects/${GOOGLE_PROJECT_ID}`,
    model: { shipments, vehicles },
  })

  const routes = response.routes
  if (!routes || routes.length === 0) {
    throw new Error('No optimized route returned from Google')
  }

  return routes[0].visits!.map((visit: any, index: number) => {
    const shipmentIndex = parseInt(visit.shipmentLabel.replace('shipment_', ''))
    const destination = destinations[shipmentIndex]
    return {
      destination_id: destination.destination_id,
      address: destination.address,
      latitude: destination.latitude,
      longitude: destination.longitude,
      optimized_sequence_order: index + 1,
    }
  })
}

//MAIN

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

  //geocode origin if missing
  let originCoords = {
    latitude: booking.origin_latitude as number,
    longitude: booking.origin_longitude as number,
  }

  if (!originCoords.latitude || !originCoords.longitude) {
    const geocoded = await geocodeAddress(booking.origin)
    originCoords = { latitude: geocoded.latitude, longitude: geocoded.longitude }
    await RouteOptimizationModel.saveOriginCoordinates(
      bookingId,
      geocoded.latitude,
      geocoded.longitude
    )
  }

  //geocode destinations if missing
  const destinations: OptimizationDestination[] = await Promise.all(
    booking.booking_destinations.map(async (dest: any) => {
      let coords = { latitude: dest.latitude, longitude: dest.longitude }

      if (!coords.latitude || !coords.longitude) {
        const geocoded = await geocodeAddress(dest.address)
        coords = { latitude: geocoded.latitude, longitude: geocoded.longitude }
        await RouteOptimizationModel.saveDestinationCoordinates(
          dest.destination_id,
          geocoded.latitude,
          geocoded.longitude
        )
      }

      return {
        destination_id: dest.destination_id,
        address: dest.address,
        latitude: coords.latitude,
        longitude: coords.longitude,
      }
    })
  )

  //call Google Routes Optimization API via official client
  const optimizedStops = await callOptimizationAPI(originCoords, destinations)

  //save optimized order to DB
  await RouteOptimizationModel.saveOptimizedOrder(optimizedStops)

  return {
    booking_id: bookingId,
    origin: { address: booking.origin, ...originCoords },
    optimized_stops: optimizedStops,
    total_stops: optimizedStops.length,
  }
}

export async function geocodeAddressService(address: string): Promise<GeocodeResult> {
  return geocodeAddress(address)
}