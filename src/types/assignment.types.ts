export type DeliveryStatus = 'pending' | 'in_transit' | 'completed' | 'cancelled'

export interface Delivery {
  delivery_id:   string
  booking_id:    string
  driver_id:     string | null
  truck_id:      string | null
  status:        DeliveryStatus
  pickup_time:   string | null
  delivery_time: string | null
  created_at:    string
  updated_at:    string
}

export interface DriverAssignment {
  assignment_id: string
  booking_id:    string
  driver_id:     string
  assigned_at:   string
  assigned_by:   string | null
}

export interface TruckAssignment {
  assignment_id: string
  booking_id:    string
  truck_id:      string
  assigned_at:   string
  assigned_by:   string | null
}

export interface AssignmentWithRelations {
  delivery_id:   string
  booking_id:    string
  driver_id:     string | null
  truck_id:      string | null
  status:        DeliveryStatus
  pickup_time:   string | null
  delivery_time: string | null
  created_at:    string
  updated_at:    string
  drivers?: {
    driver_id:      string
    license_number: string
    license_expiry: string
    status:         string
    users?: {
      user_id:    string
      first_name: string | null
      last_name:  string | null
      phone:      string | null
      email:      string
    }
  } | null
  trucks?: {
    truck_id:     string
    plate_number: string
    status:       string
    owned_by:     string | null
    truck_models?: {
      vehicle_type: string
      name:         string
    } | null
  }
  bookings?: {
    booking_id:        string
    origin:            string
    status:            string
    schedule_date:     string
    truck_type_needed: string
    clients?: {
      company_name: string | null
    } | null
  } | null
}

export interface AssignBookingInput {
  driver_id: string
  truck_id:  string
}

export interface UpdateDeliveryStatusInput {
  status:        DeliveryStatus
  pickup_time?:  string
  delivery_time?: string
}