export interface Truck {
  truck_id:         string
  plate_number:     string
  truck_type:       string
  capacity_tons:    number
  status:           'available' | 'in_use' | 'under_maintenance' | 'inactive' | 'archived'
  owned_by:         'company' | 'subcontractor'
  subcontractor_id?: string | null
  created_at:       string
  updated_at:       string
}

export interface CreateTruckInput {
  plate_number:      string
  truck_type:        string
  capacity_tons:     number
  owned_by:          'company' | 'subcontractor'
  subcontractor_id?: string | null
  created_by?:       string | null
}

export interface UpdateTruckInput {
  plate_number?:     string
  truck_type?:       string
  capacity_tons?:    number
  status?:           'available' | 'in_use' | 'under_maintenance' | 'inactive'
  owned_by?:         'company' | 'subcontractor'
  subcontractor_id?: string | null
}