export interface Coordinate {
  latitude: number
  longitude: number
}

export interface OptimizationDestination {
  destination_id: string
  address: string
  latitude: number
  longitude: number
}

export interface OptimizedStop {
  destination_id: string
  address: string
  latitude: number
  longitude: number
  optimized_sequence_order: number
}

export interface OptimizeRouteInput {
  booking_id: string
  origin: {
    address: string
    latitude: number
    longitude: number
  }
  destinations: OptimizationDestination[]
}

export interface OptimizeRouteResponse {
  booking_id: string
  origin: {
    address: string
    latitude: number
    longitude: number
  }
  optimized_stops: OptimizedStop[]
  total_stops: number
}

export interface GeocodeResult {
  address: string
  latitude: number
  longitude: number
}