export type UserRole = 'admin' | 'super_admin' | 'driver' | 'porter' | 'client' | 'subcontractor'
export type UserStatus = 'active' | 'inactive' | 'archived'

export interface BaseUser {
  user_id: string
  username: string
  email: string
  first_name: string
  last_name: string
  middle_initial?: string | null
  suffix?: string | null
  phone?: string | null
  role: UserRole
  status: UserStatus
  created_at: string
  updated_at: string
  created_by?: string | null
}

export interface BaseCreateDTO {
  username: string
  email: string
  password: string
  first_name: string
  last_name: string
  middle_initial?: string | null
  suffix?: string | null
  phone?: string | null
  created_by?: string | null
}