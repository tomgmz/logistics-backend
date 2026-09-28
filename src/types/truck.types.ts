import { TruckModel } from './truck-model.types.js'

/** The vehicle's regular driver, as the fleet list shows them. */
export interface AssignedDriver {
  driver_id:      string
  license_number: string | null
  status:         string | null
  first_name:     string | null
  last_name:      string | null
}

export interface Truck {
  truck_id:           string
  plate_number:       string
  model_id?:          string | null
  vehicle_type:       string | null
  model_name:         string | null
  truck_model?:       TruckModel | null
  status:             'available' | 'recheck_due' | 'in_use' | 'under_maintenance' | 'inactive' | 'archived'
  /** Who normally drives it. A default for assignment, never a lock — see the
   *  20260910220000_truck_assigned_driver migration. */
  assigned_driver_id?: string | null
  assigned_driver?:    AssignedDriver | null
  // Routine service: every N km or N months since the last service, whichever
  // comes first — see lib/service-schedule.
  service_interval_km?:      number | null
  service_interval_months?:  number | null
  last_service_at?:          string | null
  last_service_odometer_km?: number | null
  /** Latest odometer reading (km) and when it was taken. */
  odometer_km?:              number | null
  odometer_recorded_at?:     string | null
  created_at:         string
  updated_at:         string
}

/** The service schedule, entered with the vehicle (there is no default). */
export interface TruckScheduleInput {
  service_interval_km?:      number
  service_interval_months?:  number
  /** `YYYY-MM-DD` — the last service, or the day it was put into service. */
  last_service_at?:          string
  last_service_odometer_km?: number
}

export interface CreateTruckInput extends TruckScheduleInput {
  plate_number:      string
  model_id?:         string | null
  /** Current odometer (km) — the vehicle's first reading. */
  odometer_km?:      number
  odometer_photo_url?: string | null
}

export interface UpdateTruckInput extends TruckScheduleInput {
  /** Only accepted while the vehicle has no reading yet (setting up an existing truck). */
  odometer_km?:       number
  plate_number?:      string
  model_id?:          string | null
  status?:            'available' | 'recheck_due' | 'in_use' | 'under_maintenance' | 'inactive'
  /** `null` clears the pairing; absent leaves it untouched. */
  assigned_driver_id?: string | null
}