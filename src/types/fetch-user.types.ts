export type UserRole =
  | 'client' | 'driver' | 'accountant'
  | 'general_manager' | 'fleet_manager'
  | 'operations_manager' | 'it_admin' | 'admin'

export interface ClientDetails {
  client_id:       string
  company_name:    string | null
  billing_address: string | null
  billing_mode:    'weekly' | 'monthly'
}

export interface DriverDetails {
  driver_id:        string
  license_number:   string
  license_expiry:   string
  status:           'available' | 'assigned' | 'on_leave' | 'inactive'
}

export interface UserListItemRaw {
  user_id:        string
  first_name:     string | null
  last_name:      string | null
  middle_name: string | null
  suffix:         string | null
  email:          string
  phone:          string | null
  role:           UserRole
  status:         'active' | 'inactive' | 'archived' | 'permanently_locked'
  created_at:     string
  updated_at:     string
  clients:        ClientDetails[]
  drivers:        DriverDetails[]
}

export interface UserListItem extends Omit<UserListItemRaw, 'clients' | 'drivers'> {
  clients: ClientDetails | null
  drivers: DriverDetails | null
}

export interface GetUsersQuery {
  role?:   string
  status?: 'active' | 'inactive' | 'archived'
  search?: string
  page?:   number
  limit?:  number
  excludeId?: string
}

export interface GetUsersResult {
  data:       UserListItem[]
  total:      number
  page:       number
  limit:      number
  totalPages: number
}

export interface UserStatsResult {
  total:    number
  active:   number
  inactive: number
  archived: number
}