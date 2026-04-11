import { TruckModel } from './truck-model.types.js'

export interface Truck {
  truck_id:          string
  plate_number:      string
  truck_type:        string
  capacity_tons:     number
  model_id?:         string | null
  truck_model?:      TruckModel | null
  status:            'available' | 'in_use' | 'under_maintenance' | 'inactive' | 'archived'
  owned_by: 'company' | 'vendor'
  vendor_id?: string | null
  created_at:        string
  updated_at:        string
}

export interface CreateTruckInput {
  plate_number:      string
  truck_type:        string
  capacity_tons:     number
  model_id?:         string | null
  owned_by: 'company' | 'vendor'
  vendor_id?: string | null
  created_by?:       string | null
}

export interface UpdateTruckInput {
  plate_number?:     string
  truck_type?:       string
  capacity_tons?:    number
  model_id?:         string | null
  status?:           'available' | 'in_use' | 'under_maintenance' | 'inactive'
  owned_by?:  'company' | 'vendor'
  vendor_id?: string | null
}