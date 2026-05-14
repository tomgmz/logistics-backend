export type BookingStatus = 'pending' | 'approved' | 'assigned' | 'in_transit' | 'completed' | 'cancelled'
export type DestinationStatus = 'pending' | 'delivered' | 'failed'

export interface BookingDestination {
  destination_id:  string
  booking_id:      string
  address:         string
  sequence_order:  number
  status:          DestinationStatus
  delivered_at?:   Date | null
  notes?:          string | null
  longitude?:      number | null
  latitude?:       number | null
  created_at?:     Date
}

export interface Booking {
  booking_id:              string
  client_id:               string
  origin:                  string
  origin_longitude?:       number | null
  origin_latitude?:        number | null
  truck_type_needed:       string
  cargo_details?:          string | null
  schedule_date:           string
  call_time:               string
  status:                  BookingStatus
  required_volume_cbm?:    number | null
  required_weight_kg?:     number | null
  required_length_cm?:     number | null
  stackable_required?:     boolean | null
  total_cost?:             number | null
  estimated_delivery?:     string | null
  payment_terms?:          string | null
  /** Up to 3 Cloudinary URLs for transaction summary documents */
  transaction_documents?:  string[] | null
  created_at?:             Date
  updated_at?:             Date
}

export interface CargoGroup {
  id:            string
  pieces:        string
  looseLength:   string
  looseWidth:    string
  looseHeight:   string
  weight:        string
  weightUnit:    string
  perItem:       string
  nonTiltable:   boolean
  nonStackable:  boolean
  commodity:     string
  product:       string
  shc:           string
  additionalShc: string
  stackable:     boolean
  oversize:      boolean
}

export interface CargoSection {
  dropoffIndex: number
  groups:       CargoGroup[]
}

export interface ParsedCargoDetails {
  service:  string
  mode:     string
  sections: CargoSection[]
}

export interface BookingWithRelations extends Booking {
  parsed_cargo?:         ParsedCargoDetails | null

  booking_destinations?: BookingDestination[]

  clients?: {
    client_id:        string
    company_name?:    string | null
    billing_address?: string | null
    payment_terms?:   number
    users?: {
      first_name: string
      last_name:  string
      email:      string
      phone?:     string | null
    }
  }

  driver_assignments?: {
    assignment_id: string
    driver_id:     string
    assigned_at?:  Date
    drivers?: {
      license_number: string
      users?: {
        first_name: string
        last_name:  string
      }
    }
  }[]

  truck_assignments?: {
    assignment_id: string
    truck_id:      string
    assigned_at?:  Date
    trucks?: {
    plate_number: string
    truck_models?: { vehicle_type: string; name: string } | null
  }
  }[]
}

export interface CreateBookingInput {
  client_id:               string
  origin:                  string
  origin_longitude?:       number
  origin_latitude?:        number
  truck_type_needed:       string
  cargo_details?:          string
  schedule_date:           string
  call_time:               string
  required_volume_cbm?:    number
  required_weight_kg?:     number
  required_length_cm?:     number
  stackable_required?:     boolean
  payment_terms?:          string
  /** Cloudinary URLs — populated after documents are uploaded pre-submission */
  transaction_documents?:  string[]
  destinations:            CreateDestinationInput[]
}

export interface CreateDestinationInput {
  address:        string
  sequence_order: number
  notes?:         string
  longitude?:     number
  latitude?:      number
}

export interface UpdateBookingInput {
  origin?:                 string
  origin_longitude?:       number | null
  origin_latitude?:        number | null
  truck_type_needed?:      string
  cargo_details?:          string
  schedule_date?:          string
  call_time?:              string
  status?:                 BookingStatus
  required_volume_cbm?:    number | null
  required_weight_kg?:     number | null
  required_length_cm?:     number | null
  stackable_required?:     boolean | null
  payment_terms?:          string | null
  transaction_documents?:  string[] | null
}

export interface UpdateDestinationInput {
  address?:        string
  sequence_order?: number
  status?:         DestinationStatus
  delivered_at?:   Date
  notes?:          string
  longitude?:      number | null
  latitude?:       number | null
}