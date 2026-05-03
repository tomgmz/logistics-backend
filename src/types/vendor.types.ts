import { UserRole, UserStatus } from './user.types.js'

export interface Vendor {
  user_id:         string
  username:        string
  email:           string
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  phone?:          string | null
  role:            UserRole
  status:          UserStatus
  created_by?:     string | null
  created_at:      string
  updated_at:      string

  vendor_id:       string
  vendor_type:     'individual' | 'company'
  company_name?:   string | null
  business_permit?: string | null
}

export interface CreateVendorInput {
  username:        string
  email:           string
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  phone?:          string | null
  created_by?:     string | null

  vendor_type:     'individual' | 'company'
  company_name?:   string | null
  business_permit?: string | null
}

export interface UpdateVendorInput {
  first_name?:     string
  last_name?:      string
  middle_name?: string | null
  suffix?:         string | null
  username?:       string
  email?:          string
  phone?:          string | null

  vendor_type?:    'individual' | 'company'
  company_name?:   string | null
  business_permit?: string | null
}