export interface Client {
  user_id:         string
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  email:           string
  phone?:          string | null
  role:            'client'
  status:          'active' | 'inactive' | 'archived'
  created_by?:     string | null
  created_at?:     Date
  updated_at?:     Date

  client_id:        string
  company_name?:    string | null
  billing_address?: string | null
  payment_terms?:   number
  landline?:        string | null
}

export interface CreateClientInput {
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         string | null
  email:           string
  phone?:          string
  created_by?:     string

  company_name?:    string
  billing_address?: string
  payment_terms?:   number
  landline?:        string | null
}

export interface UpdateClientInput {
  first_name?:     string
  last_name?:      string
  middle_name?:    string | null
  suffix?:         string | null
  email?:          string
  phone?:          string

  company_name?:    string
  billing_address?: string
  payment_terms?:   number
  landline?:        string | null
}