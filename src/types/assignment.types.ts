export type DeliveryStatus = 'pending' | 'in_transit' | 'completed' | 'cancelled'

export interface VendorSnapshot {
  is_vendor_supplied:    boolean
  vendor_name:           string | null
  vendor_contact:        string | null
  vendor_driver_name:    string | null
  vendor_driver_license: string | null
  vendor_driver_phone:   string | null
  vendor_vehicle_plate:  string | null
  vendor_vehicle_type:   string | null
}

export interface Delivery extends VendorSnapshot {
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

export interface AssignmentWithRelations extends VendorSnapshot {
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
  driver_id?: string
  truck_id?:  string

  is_vendor_supplied?:   boolean
  vendor_name?:          string
  vendor_contact?:       string
  vendor_driver_name?:   string
  vendor_driver_license?: string
  vendor_driver_phone?:  string
  vendor_vehicle_plate?: string
  vendor_vehicle_type?:  string
}

export interface UpdateDeliveryStatusInput {
  status:        DeliveryStatus
  pickup_time?:  string
  delivery_time?: string
}