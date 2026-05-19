export type BookingStatus      = 'pending' | 'approved' | 'assigned' | 'in_transit' | 'completed' | 'cancelled'
export type DestinationStatus  = 'pending' | 'delivered' | 'failed'
export type AccountingStatus   = 'pending' | 'approved' | 'rejected' | 'forwarded'
export type GmStatus           = 'pending' | 'approved' | 'rejected'
export type OpsStatus          = 'pending' | 'assigned'
export type FleetStatus        = 'pending' | 'approved'

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

export interface BookingCargoItem {
  item_id:        string
  booking_id?:    string
  // catalog FK picks
  product_id?:    string | null
  commodity_id?:  string | null
  shc_id?:        string | null
  ashc_id?:       string | null
  // free-text fallbacks (mutually exclusive with FK counterpart)
  commodity_text?: string | null
  product_text?:   string | null
  shc_text?:       string | null
  ashc_text?:      string | null
  // dimensions
  quantity?:      number | null
  weight_kg?:     number | null
  volume_cbm?:    number | null
  length_cm?:     number | null
  width_cm?:      number | null
  height_cm?:     number | null
  notes?:         string | null
  created_at?:    Date
  updated_at?:    Date
  // joined relations
  products?:      { name: string; unit?: string | null } | null
  commodities?:   { name: string; category?: string | null } | null
  shc?:           { code: string; name: string; type: string } | null
  ashc?:          { code: string; name: string; type: string } | null
}

export interface CreateCargoItemInput {
  commodity_id?:   string
  commodity_text?: string
  product_id?:     string
  product_text?:   string
  shc_id?:         string
  shc_text?:       string
  ashc_id?:        string
  ashc_text?:      string
  quantity?:       number
  weight_kg?:      number
  volume_cbm?:     number
  length_cm?:      number
  width_cm?:       number
  height_cm?:      number
  notes?:          string
}

export interface UpdateCargoItemInput extends Partial<CreateCargoItemInput> {}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export interface BookingDestination {
  destination_id:  string
  booking_id:      string
  delivery_id?:    string | null   // fix #5
  address:         string
  sequence_order:  number
  status:          DestinationStatus
  delivered_at?:   Date | null
  notes?:          string | null
  longitude?:      number | null
  latitude?:       number | null
  created_at?:     Date
}

export interface CreateDestinationInput {
  address:        string
  sequence_order: number
  notes?:         string
  longitude?:     number
  latitude?:      number
}

export interface UpdateDestinationInput {
  address?:        string
  sequence_order?: number
  status?:         DestinationStatus
  delivered_at?:   Date | null
  notes?:          string
  longitude?:      number | null
  latitude?:       number | null
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export interface Booking {
  booking_id:             string
  client_id:              string
  origin:                 string
  origin_longitude?:      number | null
  origin_latitude?:       number | null
  truck_type_needed:      string
  schedule_date:          string
  call_time:              string
  status:                 BookingStatus

  // approval pipeline columns (fix #2)
  accounting_status?:     AccountingStatus | null
  gm_status?:             GmStatus | null
  ops_status?:            OpsStatus | null
  fleet_status?:          FleetStatus | null
  rejection_reason?:      string | null
  cancelled_by?:          string | null
  cancelled_at?:          Date | null
  reference_number?:      string | null

  // cargo dimensions & cost
  required_volume_cbm?:   number | null
  required_weight_kg?:    number | null
  required_length_cm?:    number | null
  stackable_required?:    boolean | null
  total_cost?:            number | null
  estimated_delivery?:    string | null
  payment_terms?:         string | null

  /** Up to 3 Cloudinary URLs for transaction summary documents */
  transaction_documents?: string[] | null

  created_at?:            Date
  updated_at?:            Date
}

export interface BookingWithRelations extends Booking {
  booking_cargo_items?: BookingCargoItem[]    // fix #10

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

  driver_assignments?: Array<{
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
  }>

  truck_assignments?: Array<{
    assignment_id: string
    truck_id:      string
    assigned_at?:  Date
    trucks?: {
      plate_number:  string
      truck_models?: { vehicle_type: string; name: string } | null
    }
  }>
}

// ---------------------------------------------------------------------------
// Create / Update inputs
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  client_id:               string
  origin:                  string
  origin_longitude?:       number
  origin_latitude?:        number
  truck_type_needed:       string
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
  cargo_items?:            CreateCargoItemInput[]   // fix #12 — replaces cargo_details blob
}

export interface UpdateBookingInput {
  origin?:                 string
  origin_longitude?:       number | null
  origin_latitude?:        number | null
  truck_type_needed?:      string
  schedule_date?:          string
  call_time?:              string
  required_volume_cbm?:    number | null
  required_weight_kg?:     number | null
  required_length_cm?:     number | null
  stackable_required?:     boolean | null
  payment_terms?:          string | null
  transaction_documents?:  string[] | null
  // NOTE: status is intentionally excluded — use updateBookingStatus endpoint
  // NOTE: approval statuses are intentionally excluded — use dedicated approval endpoints
}

// Approval pipeline inputs (fix #4)
export interface AccountingReviewInput {
  accounting_status: Exclude<AccountingStatus, 'pending'>
  rejection_reason?: string
}

export interface GmReviewInput {
  gm_status:         Exclude<GmStatus, 'pending'>
  rejection_reason?: string
}

export interface OpsAssignInput {
  ops_status: 'assigned'
}

export interface FleetApproveInput {
  fleet_status: 'approved'
}