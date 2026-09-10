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
  status:             'available' | 'in_use' | 'under_maintenance' | 'inactive' | 'archived'
  /** Who normally drives it. A default for assignment, never a lock — see the
   *  20260910220000_truck_assigned_driver migration. */
  assigned_driver_id?: string | null
  assigned_driver?:    AssignedDriver | null
  created_at:         string
  updated_at:         string
}

export interface CreateTruckInput {
  plate_number:      string
  model_id?:         string | null
}

export interface UpdateTruckInput {
  plate_number?:      string
  model_id?:          string | null
  status?:            'available' | 'in_use' | 'under_maintenance' | 'inactive'
  /** `null` clears the pairing; absent leaves it untouched. */
  assigned_driver_id?: string | null
}