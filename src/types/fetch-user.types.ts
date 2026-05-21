export type UserRole =
  | 'client' | 'driver' | 'vendor' | 'accountant'
  | 'general_manager' | 'fleet_admin'
  | 'operations_admin' | 'it_admin' | 'admin'

export interface ClientDetails {
  client_id:       string
  company_name:    string | null
  billing_address: string | null
  payment_terms:   number
}

export interface DriverDetails {
  driver_id:        string
  license_number:   string
  license_expiry:   string
  status:           'available' | 'assigned' | 'on_leave' | 'inactive'
  is_vendor_driver: boolean
  vendor_id:        string | null
}

export interface VendorDetails {
  vendor_id:       string
  vendor_type:     'individual' | 'company'
  company_name:    string | null
  business_permit: string | null
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
  vendors:        VendorDetails[]
}

export interface UserListItem extends Omit<UserListItemRaw, 'clients' | 'drivers' | 'vendors'> {
  clients: ClientDetails | null
  drivers: DriverDetails | null
  vendors: VendorDetails | null
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