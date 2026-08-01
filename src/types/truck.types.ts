import { TruckModel } from './truck-model.types.js'

export interface Truck {
  truck_id:          string
  plate_number:      string
  model_id?:         string | null
  vehicle_type:      string | null
  model_name:        string | null
  truck_model?:      TruckModel | null
  status:            'available' | 'in_use' | 'under_maintenance' | 'inactive' | 'archived'
  created_at:        string
  updated_at:        string
}

export interface CreateTruckInput {
  plate_number:      string
  model_id?:         string | null
}

export interface UpdateTruckInput {
  plate_number?:     string
  model_id?:         string | null
  status?:           'available' | 'in_use' | 'under_maintenance' | 'inactive'
}