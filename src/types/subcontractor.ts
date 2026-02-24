import { UserRole, UserStatus } from './user.types.js'

export interface Client {
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
  created_at:         string
  updated_at:         string
  subcontractor_type: string
  company_name:       string
  business_permit:    string
}

export interface CreateClientInput {
  username:           string
  email:              string
  password:           string
  first_name:         string
  last_name:          string
  middle_initial?:    string | null
  suffix?:            string | null
  phone?:             string | null
  created_by?:        string | null
  subcontractor_type: string
  company_name:       string
  business_permit:    string
}

export interface UpdateClientInput {
  first_name?:        string
  last_name?:         string
  middle_initial?:    string | null
  suffix?:            string | null
  phone?:             string | null
  subcontractor_type: string
  company_name:       string
  business_permit:    string
}