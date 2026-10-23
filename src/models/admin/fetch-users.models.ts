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
  'general-managers':  'general_manager',
  'fleet-admins':      'fleet_manager',
  'operations-admins': 'operations_manager',
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
        billing_address
      ),
      drivers (
        driver_id,
        license_number,
        license_expiry,
        status
      )
    `
    )
    .order('last_name', { ascending: true })

  // Company Administrators are left out of an unfiltered list, but a caller that
  // names the role (Administrator Management's "All Administrators") gets them.
  if (roleFilters?.length === 1) q = q.eq('role', roleFilters[0])
  else if (roleFilters?.length)  q = q.in('role', roleFilters)
  else                           q = q.neq('role', 'admin')
  if (query.status) q = q.eq('status', query.status)
  else              q = q.neq('status', 'archived')

  if (query.search) {
    const s = query.search.trim()
    q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%`)
  }

  if (query.excludeId) q = q.neq('user_id', query.excludeId)

  const { data, error } = await q
  if (error) throw error

  const normalized: UserListItem[] = ((data ?? []) as UserListItemRaw[]).map((u) => ({
    ...u,
    clients: u.clients?.[0] ?? null,
    drivers: u.drivers?.[0] ?? null,
  }))

  return {
    data:       normalized,
    total:      normalized.length,
    page:       1,
    limit:      normalized.length,
    totalPages: 1,
  }
}

export async function countUsersByStatus(roles?: string[], excludeId?: string): Promise<UserStatsResult> {
  let q = supabase
    .from('users')
    .select('status')

  // Same rule as findAllUsers: admins count only when the caller names the role.
  if (roles?.length)  q = q.in('role', roles)
  else                q = q.neq('role', 'admin')
  if (excludeId)      q = q.neq('user_id', excludeId)

  const { data, error } = await q
  if (error) throw error

  return {
    total:    data.length,
    active:   data.filter((u) => u.status === 'active').length,
    inactive: data.filter((u) => u.status === 'inactive').length,
    archived: data.filter((u) => u.status === 'archived').length,
  }
}