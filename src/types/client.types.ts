export interface Client {
  // from users table
  user_id: string
  first_name: string
  last_name: string
  middle_initial?: string | null
  suffix?: string | null
  username: string
  email: string
  phone?: string | null
  role: 'client'
  status: 'active' | 'inactive' | 'archived'
  created_by?: string | null
  created_at?: Date
  updated_at?: Date

  // from clients table
  client_id: string
  company_name?: string | null
  billing_address?: string | null
  payment_terms?: number
}

export interface CreateClientInput {
  // from users table
  first_name: string
  last_name: string
  middle_initial?: string | null
  suffix?: string | null
  username: string
  email: string
  password: string
  phone?: string
  created_by?: string

  // from clients table
  company_name?: string
  billing_address?: string
  payment_terms?: number
}

export interface UpdateClientInput {
  // from users table
  first_name?: string
  last_name?: string
  middle_initial?: string | null
  suffix?: string | null
  username?: string
  email?: string
  phone?: string

  // from clients table
  company_name?: string
  billing_address?: string
  payment_terms?: number
}