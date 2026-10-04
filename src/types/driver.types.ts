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
  /** True for a vendor driver: passkey sign-in, never a password. */
  is_external?:       boolean
  vendor_name?:       string | null
  vendor_contact?:    string | null
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
  // Written only on a vendor driver; ignored for a company driver.
  vendor_name?:       string
  vendor_contact?:    string | null
}