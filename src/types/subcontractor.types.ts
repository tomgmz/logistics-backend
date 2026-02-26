import { UserRole, UserStatus } from './user.types.js'

export interface Subcontractor {
  user_id:            string
  username:           string
  email:              string
  first_name:         string
  last_name:          string
  middle_initial?:    string | null
  suffix?:            string | null
  phone?:             string | null
  role:               UserRole
  status:             UserStatus
  created_by?:        string | null
  created_at:         string
  updated_at:         string

  subcontractor_id:   string
  subcontractor_type: 'individual' | 'company'
  company_name?:      string | null
  business_permit?:   string | null
}

export interface CreateSubcontractorInput {
  username:           string
  email:              string
  password:           string
  first_name:         string
  last_name:          string
  middle_initial?:    string | null
  suffix?:            string | null
  phone?:             string | null
  created_by?:        string | null

  subcontractor_type: 'individual' | 'company'
  company_name?:      string | null
  business_permit?:   string | null
}

export interface UpdateSubcontractorInput {
  first_name?:        string
  last_name?:         string
  middle_initial?:    string | null
  suffix?:            string | null
  username?:          string
  email?:             string
  phone?:             string | null

  subcontractor_type?: 'individual' | 'company'
  company_name?:       string | null
  business_permit?:    string | null
}