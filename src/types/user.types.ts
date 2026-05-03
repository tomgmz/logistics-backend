export type UserRole = 'admin' | 'super_admin' | 'driver' | 'client' | 'vendor' | 'accountant' | 'general_manager'
export type UserStatus = 'active' | 'inactive' | 'archived'
export type UserSuffix = 'Jr.' | 'Sr.' | 'II' | 'III' | 'IV' | 'V'

export const USER_SUFFIXES = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V'] as const

export interface BaseUser {
  user_id:         string
  username:        string
  email:           string
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         UserSuffix | null
  phone?:          string | null
  role:            UserRole
  status:          UserStatus
  created_at:      string
  updated_at:      string
  created_by?:     string | null
}

export interface BaseCreateDTO {
  username:        string
  email:           string
  first_name:      string
  last_name:       string
  middle_name?: string | null
  suffix?:         UserSuffix | null
  phone?:          string | null
  created_by?:     string | null
}