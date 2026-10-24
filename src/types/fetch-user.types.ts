export type UserRole =
  | 'client' | 'driver'
  | 'general_manager' | 'fleet_manager'
  | 'operations_manager' | 'it_admin' | 'admin'

export interface ClientDetails {
  client_id:       string
  company_name:    string | null
  billing_address: string | null
  landline:        string | null
}

export interface DriverDetails {
  driver_id:        string
  license_number:   string
  license_expiry:   string
  status:           'available' | 'assigned' | 'on_leave' | 'inactive'
  is_external:      boolean
  vendor_name:      string | null
  vendor_contact:   string | null
  license_image_url: string | null
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
  last_login_at:  string | null
  clients:        ClientDetails | ClientDetails[] | null
  drivers:        DriverDetails | DriverDetails[] | null
}

export interface UserListItem extends Omit<UserListItemRaw, 'clients' | 'drivers'> {
  clients: ClientDetails | null
  drivers: DriverDetails | null
}

export interface GetUsersQuery {
  role?:   string
  // One status, or a comma list ("active,deactivated").
  status?: string
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