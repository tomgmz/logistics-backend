import { UserRole, UserStatus } from './user.types.js'

export interface Helper {
  user_id:         string
  username:        string
  email:           string
  first_name:      string
  last_name:       string
  middle_initial?: string | null
  suffix?:         string | null
  phone?:          string | null
  role:            UserRole
  status:          UserStatus
  created_by?:     string | null
  created_at:      string
  updated_at:      string

  helper_id:        string
  license_number?:  string | null
  license_expiry?:  string | null
  driver_status:    'available' | 'assigned' | 'on_leave' | 'inactive'
}

export interface CreateHelperDTO {
  username:        string
  email:           string
  password:        string
  first_name:      string
  last_name:       string
  middle_initial?: string | null
  suffix?:         string | null
  phone?:          string | null
  created_by?:     string | null
  license_number?: string | null
  license_expiry?: string | null
}

export interface UpdateHelperDTO {
  first_name?:     string
  last_name?:      string
  middle_initial?: string | null
  suffix?:         string | null
  username?:       string
  email?:          string
  phone?:          string | null
  license_number?: string | null
  license_expiry?: string | null
  driver_status?:  'available' | 'assigned' | 'on_leave' | 'inactive'
}