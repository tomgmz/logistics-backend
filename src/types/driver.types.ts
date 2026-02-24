import { UserRole, UserStatus } from './user.types.js'

export interface Driver {
  user_id:                 string
  username:                string
  email:                   string
  first_name:              string
  last_name:               string
  middle_initial?:         string | null
  suffix?:                 string | null
  phone?:                  string | null
  role:                    UserRole
  status:                  UserStatus
  created_at:              string
  updated_at:              string
  created_by?:             string | null
  license_number:          string
  license_expiry:          string
  is_subcontractor_driver: boolean
  subcontractor_id?:       string | null
}

export interface CreateDriverDTO {
  username:                 string
  email:                    string
  password:                 string
  first_name:               string
  last_name:                string
  middle_initial?:          string | null
  suffix?:                  string | null
  phone?:                   string | null
  created_by?:              string | null
  license_number:           string
  license_expiry:           string
  is_subcontractor_driver?: boolean
  subcontractor_id?:        string | null
}

export interface UpdateDriverDTO {
  first_name?:              string
  last_name?:               string
  middle_initial?:          string | null
  suffix?:                  string | null
  phone?:                   string | null
  license_number?:          string
  license_expiry?:          string
  is_subcontractor_driver?: boolean
  subcontractor_id?:        string | null
}