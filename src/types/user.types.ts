export type UserRole = 'admin' | 'super_admin' | 'driver' | 'porter' | 'client' | 'subcontractor'
export type UserStatus = 'active' | 'inactive' | 'archived'

export interface User {
  user_id: string
  first_name: string
  last_name: string
  middle_initial?: string
  suffix?: string
  username: string
  email: string
  phone?: string
  role: UserRole
  status: UserStatus
  created_at: string
  updated_at: string
  created_by?: string
}

export interface CreateUserDTO {
  first_name: string
  last_name: string
  suffix?: string
  middle_initial?: string
  username: string
  email: string
  password: string
  phone?: string
  role: UserRole
  created_by?: string

  // driver role
  license_number?: string
  license_expiry?: string
  is_subcontractor_driver?: boolean
  subcontractor_id?: string

  // client role
  company_name?: string
  billing_address?: string
  payment_terms?: number

  // subcotractor role
  subcon_company_name?: string
  business_permit?: string
  subcontractor_type?: string
}