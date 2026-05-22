import { UserRole, UserStatus } from './user.types.js'

export interface Driver {
  user_id:           string
  email:             string
  first_name:        string
  last_name:         string
  middle_name?:      string | null
  suffix?:           string | null
  phone?:            string | null
  role:              UserRole
  status:            UserStatus
  created_at:        string
  updated_at:        string
  created_by?:       string | null
  license_number:    string
  license_expiry:    string
  license_image_url?: string | null
  is_vendor_driver:  boolean
  vendor_id?:        string | null
}

export interface CreateDriverDTO {
  email:              string
  first_name:         string
  last_name:          string
  middle_name?:       string | null
  suffix?:            string | null
  phone?:             string | null
  created_by?:        string | null
  license_number:     string
  license_expiry:     string
  license_image_url?: string | null
  is_vendor_driver?:  boolean
  vendor_id?:         string | null
}

export interface UpdateDriverDTO {
  first_name?:        string
  last_name?:         string
  middle_name?:       string | null
  suffix?:            string | null
  email?:             string
  phone?:             string | null
  license_number?:    string
  license_expiry?:    string
  license_image_url?: string | null
  is_vendor_driver?:  boolean
  vendor_id?:         string | null
}