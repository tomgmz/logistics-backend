import { supabase } from '../../lib/supabase.js'
import {
  GetUsersQuery,
  GetUsersResult,
  UserListItem,
  UserListItemRaw,
  UserStatsResult,
} from '../../types/fetch-user.types.js'

const ROLE_MAP: Record<string, string> = {
  'clients':           'client',
  'drivers':           'driver',
  'vendors':           'vendor',
  'accountants':       'accountant',
  'general-managers':  'general_manager',
  'human-resources':   'human_resources',
  'fleet-admins':      'fleet_admin',
  'operations-admins': 'operations_admin',
  'it-admins':         'it_admin',
}

export async function findAllUsers(query: GetUsersQuery): Promise<GetUsersResult> {
  const roleFilters = query.role
    ? query.role.split(',').map((r) => ROLE_MAP[r.trim()] ?? r.trim())
    : null

  let q = supabase
    .from('users')
    .select(
      `
      user_id,
      first_name,
      last_name,
      middle_name,
      suffix,
      email,
      phone,
      role,
      status,
      created_at,
      updated_at,
      clients (
        client_id,
        company_name,
        billing_address,
        payment_terms
      ),
      drivers (
        driver_id,
        license_number,
        license_expiry,
        status,
        is_vendor_driver,
        vendor_id
      ),
      vendors (
        vendor_id,
        vendor_type,
        company_name,
        business_permit
      )
    `
    )
    .neq('role', 'admin')
    .order('last_name', { ascending: true })

  if (roleFilters?.length === 1) q = q.eq('role', roleFilters[0])
  else if (roleFilters?.length)  q = q.in('role', roleFilters)
  if (query.status) q = q.eq('status', query.status)
  else              q = q.neq('status', 'archived')

  if (query.search) {
    const s = query.search.trim()
    q = q.or(
      `first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%`
    )
  }

  const { data, error } = await q
  if (error) throw error

  const normalized: UserListItem[] = ((data ?? []) as UserListItemRaw[]).map((u) => ({
    ...u,
    clients: u.clients?.[0] ?? null,
    drivers: u.drivers?.[0] ?? null,
    vendors: u.vendors?.[0] ?? null,
  }))

  return {
    data:       normalized,
    total:      normalized.length,
    page:       1,
    limit:      normalized.length,
    totalPages: 1,
  }
}

export async function countUsersByStatus(roles?: string[]): Promise<UserStatsResult> {
  let q = supabase
    .from('users')
    .select('status')
    .neq('role', 'admin')

  if (roles?.length) q = q.in('role', roles)

  const { data, error } = await q
  if (error) throw error

  return {
    total:    data.length,
    active:   data.filter((u) => u.status === 'active').length,
    inactive: data.filter((u) => u.status === 'inactive').length,
    archived: data.filter((u) => u.status === 'archived').length,
  }
}