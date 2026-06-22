import { supabase } from './supabase.js'
import { defaultPermissionsForRole, isManagedRole } from '../constants/modules.js'
import * as PermissionsModel from '../models/admin/permissions.model.js'

export type ProvisionRole =
  | 'admin'
  | 'client'
  | 'driver'
  | 'vendor'
  | 'it_admin'
  | 'operations_manager'
  | 'accountant'
  | 'general_manager'
  | 'fleet_manager'

export interface BaseUserFields {
  email:                 string
  first_name?:           string | null
  last_name?:            string | null
  middle_name?:          string | null
  suffix?:               string | null
  phone?:                string | null
  created_by?:           string | null
  must_change_password?: boolean
}

/**
 * Atomically create the public.users row plus the role-specific detail row
 * (clients/drivers/vendors) via the create_user_with_profile DB function.
 *
 * Both inserts run inside a single Postgres transaction: if either fails the
 * whole thing rolls back, so the database never keeps a partial profile. The
 * caller is still responsible for rolling back the Supabase Auth user when
 * this throws (see deleteAuthUserSafely).
 */
export async function createUserWithProfile(
  userId: string,
  role:    ProvisionRole,
  user:    BaseUserFields,
  detail?: Record<string, unknown> | null,
) {
  const { data, error } = await supabase.rpc('create_user_with_profile', {
    p_user_id: userId,
    p_role:    role,
    p_user:    user,
    p_detail:  detail ?? null,
  })
  if (error) throw error

  // Seed least-privilege default module permissions for managed staff roles, so a
  // new user starts on their role's default tiers instead of full access. Best
  // effort: the user already exists and falls back to role-default access if this
  // fails, so we log and continue rather than rolling back the whole creation.
  if (isManagedRole(role)) {
    try {
      await PermissionsModel.replaceForUser(
        userId,
        user.created_by ?? null,
        defaultPermissionsForRole(role),
      )
    } catch (seedError) {
      console.error('Failed to seed default permissions for', userId, role, seedError)
    }
  }

  return data
}
