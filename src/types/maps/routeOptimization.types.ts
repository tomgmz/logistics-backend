export interface Coordinate {
  latitude: number
  longitude: number
}

export interface OptimizationDestination {
  destination_id: string
  address: string
  latitude: number
  longitude: number
  status?: 'pending' | 'delivered' | 'failed'
  notes?: string | null
}

export interface OptimizedStop {
  destination_id: string
  address: string
  latitude: number
  longitude: number
  optimized_sequence_order: number
  status: 'pending' | 'delivered' | 'failed'
  notes?: string | null 
  /** Loads bound for this drop-off across the trips (1 when not split), and how many have unloaded. */
  loads_total?: number
  loads_done?:  number
}

export interface OptimizeRouteResponse {
  booking_id: string
  /** The drop-off the driver is heading to on the loaded run, in the driver's order. Null when not on the road. */
  heading_to_destination_id?: string | null
  total_stops: number
  origin: {
    address: string
    latitude: number
    longitude: number
  }
  optimized_stops: OptimizedStop[]
}

export interface GeocodeResult {
  address: string
  latitude: number
  longitude: number
}