export type BookingStatus = 'pending' | 'assigned' | 'in_transit' | 'completed' | 'cancelled'
export type DestinationStatus = 'pending' | 'delivered' | 'failed'

export interface BookingDestination {
  destination_id: string
  booking_id: string
  address: string
  sequence_order: number
  status: DestinationStatus
  delivered_at?: Date | null
  notes?: string | null
  created_at?: Date
}

export interface Booking {
  booking_id: string
  client_id: string
  origin: string
  truck_type_needed: string
  cargo_details?: string | null
  schedule_date: string
  call_time: string
  status: BookingStatus
  created_at?: Date
  updated_at?: Date
}

export interface BookingWithRelations extends Booking {
  //joined from booking_destinations
  booking_destinations?: BookingDestination[]

  //joined from clients table
  clients?: {
    client_id: string
    company_name?: string | null
    billing_address?: string | null
    payment_terms?: number
    users?: {
      first_name: string
      last_name: string
      email: string
      phone?: string | null
    }
  }

  //joined from driver_assignments
  driver_assignments?: {
    assignment_id: string
    driver_id: string
    assigned_at?: Date
    drivers?: {
      license_number: string
      users?: {
        first_name: string
        last_name: string
      }
    }
  }[]

  //joined from truck_assignments
  truck_assignments?: {
    assignment_id: string
    truck_id: string
    assigned_at?: Date
    trucks?: {
      plate_number: string
      truck_type: string
      capacity_tons: number
    }
  }[]
}

export interface CreateBookingInput {
  client_id: string
  origin: string
  truck_type_needed: string
  cargo_details?: string
  schedule_date: string
  call_time: string
  destinations: CreateDestinationInput[]
}

export interface CreateDestinationInput {
  address: string
  sequence_order: number
  notes?: string
}

export interface UpdateBookingInput {
  origin?: string
  truck_type_needed?: string
  cargo_details?: string
  schedule_date?: string
  call_time?: string
  status?: BookingStatus
}

export interface UpdateDestinationInput {
  address?: string
  sequence_order?: number
  status?: DestinationStatus
  delivered_at?: Date
  notes?: string
}