// The four values `deliveries_status_check` actually permits. 'completed' and
// 'cancelled' were listed here and accepted by the API, but the database has
// never allowed them — writing either raised a constraint violation.
export type DeliveryStatus = 'pending' | 'in_transit' | 'delivered' | 'failed'

export interface VendorSnapshot {
  is_vendor_supplied:    boolean
  vendor_name:           string | null
  vendor_contact:        string | null
  vendor_driver_name:    string | null
  vendor_driver_license: string | null
  vendor_driver_phone:   string | null
  vendor_vehicle_plate:  string | null
  vendor_vehicle_type:   string | null

  // Optional app access for the vendor's driver. When ops supplies an email we
  // provision a minimal account and the driver enrols a passkey on their own
  // phone; without one the assignment behaves exactly as it always has and the
  // snapshot above is the whole record.
  vendor_driver_email:   string | null
  vendor_driver_user_id: string | null
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

/** The optional second driver on a booking (driver_assignments, crew_role 'second'). */
export interface SecondDriver {
  driver_id:      string
  license_number: string | null
  license_expiry: string | null
  is_external:    boolean
  vendor_name:    string | null
  users: {
    user_id:    string
    first_name: string | null
    last_name:  string | null
    phone:      string | null
    email:      string | null
  } | null
}

export interface AssignmentWithRelations extends VendorSnapshot {
  /** Attached by the model from driver_assignments; null when there is none. */
  second_driver?: SecondDriver | null
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
    truck_type_needed: string | null
    clients?: {
      company_name: string | null
    } | null
  } | null
}

// What the assignment WRITE takes. On the vendor path the request only carries
// vendor_driver_user_id + the vehicle; the service fills the driver and vendor
// snapshot fields below from the registered vendor driver before calling assign().
export interface AssignBookingInput {
  driver_id?: string
  truck_id?:  string

  is_vendor_supplied?:   boolean
  vendor_driver_user_id?: string
  // Optional second driver. Company path: a drivers.driver_id from the same
  // assignable pool as the main driver. Vendor path: a registered vendor
  // driver's user_id.
  second_driver_id?:             string | null
  second_vendor_driver_user_id?: string | null
  vendor_name?:          string | null
  vendor_contact?:       string | null
  vendor_driver_name?:   string
  vendor_driver_license?: string | null
  vendor_driver_phone?:  string | null
  vendor_vehicle_plate?: string
  vendor_vehicle_type?:  string
  vendor_driver_email?:  string
}

export interface UpdateDeliveryStatusInput {
  status:        DeliveryStatus
  pickup_time?:  string
  delivery_time?: string
}