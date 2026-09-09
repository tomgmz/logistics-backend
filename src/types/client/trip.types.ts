import type { BookingDestination } from './booking.types.js'

/**
 * A booking is completed by one vehicle making one or more RUNS.
 *
 * 'pending'    — planned, not yet loaded
 * 'in_transit' — the driver confirmed loading for this run; the truck is out
 * 'completed'  — every stop on this run confirmed
 * 'cancelled'  — planned but not needed (the load fit in fewer runs than ops expected)
 */
export type TripStatus     = 'pending' | 'in_transit' | 'completed' | 'cancelled'
export type TripStopStatus = 'pending' | 'delivered' | 'failed'

export interface BookingTrip {
  trip_id:     string
  booking_id:  string
  trip_number: number
  status:      TripStatus

  // Proof of loading for THIS run. Every trip carries its own: a single photo
  // cannot evidence the second time the truck was filled.
  pickup_proof_photo_url?:       string | null
  pickup_proof_at?:              string | null
  pickup_proof_latitude?:        number | null
  pickup_proof_longitude?:       number | null
  pickup_proof_accuracy_m?:      number | null
  pickup_proof_distance_m?:      number | null
  pickup_proof_override_reason?: string | null

  notes?:      string | null
  created_at?: string
  updated_at?: string
}

export interface BookingTripStop {
  trip_stop_id:   string
  trip_id:        string
  destination_id: string
  /** Order of the unload points within this run — not the bay's order on the booking. */
  sequence_order: number
  status:         TripStopStatus
  delivered_at?:  string | null

  proof_photo_url?:       string | null
  proof_at?:              string | null
  proof_latitude?:        number | null
  proof_longitude?:       number | null
  proof_accuracy_m?:      number | null
  proof_distance_m?:      number | null
  proof_override_reason?: string | null

  created_at?: string
  updated_at?: string

  // joined
  booking_destinations?: Pick<
    BookingDestination,
    'destination_id' | 'address' | 'sequence_order' | 'latitude' | 'longitude' | 'notes' | 'status'
  > | null
}

export interface TripWithStops extends BookingTrip {
  booking_trip_stops: BookingTripStop[]
}

/** One run as operations plans it: which bays it serves, in what order. */
export interface TripPlanInput {
  trip_number?:    number
  destination_ids: string[]
  notes?:          string | null
}
