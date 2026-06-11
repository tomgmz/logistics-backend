import { supabase } from '../../lib/supabase.js'
import * as PermissionsModel from '../../models/admin/permissions.model.js'
import { invalidateUserPermissions } from '../../middlewares/moduleAccess.middleware.js'
import { isProtectedAdmin } from '../../lib/protected-admin.js'
import { logEvent } from '../../lib/log-event.js'
import { isManagedRole, pickFlags, MODULES_BY_ROLE, ManagedRole } from '../../constants/modules.js'
import {
  ModulePermissionInput,
  ModulePermissionRow,
  ModulePermissionSummary,
} from '../../types/permissions.types.js'

function toSummary(r: ModulePermissionRow): ModulePermissionSummary {
  return { module_key: r.module_name, ...pickFlags(r) }
}

async function getTargetUser(userId: string): Promise<{ user_id: string; role: string }> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('User not found')
  return data
}

export async function getUserPermissions(userId: string): Promise<{
  role:        string
  modules:     string[]
  protected:   boolean
  permissions: ModulePermissionSummary[]
}> {
  const target = await getTargetUser(userId)
  const rows   = await PermissionsModel.findByUser(userId)

  return {
    // Only the modules this role actually has pages for are assignable.
    role:        target.role,
    modules:     isManagedRole(target.role) ? MODULES_BY_ROLE[target.role as ManagedRole] : [],
    protected:   await isProtectedAdmin(userId),
    permissions: rows.map(toSummary),
  }
}

export async function setUserPermissions(
  userId:   string,
  items:    ModulePermissionInput[],
  actorId?: string | null,
): Promise<ModulePermissionSummary[]> {
  const target = await getTargetUser(userId)

  if (!isManagedRole(target.role)) {
    throw new Error('Module permissions can only be assigned to managed staff roles.')
  }

  if (await isProtectedAdmin(userId)) {
    throw new Error('protected: The primary administrator account cannot be restricted.')
  }

  // Only persist modules this role actually has pages for; drop anything else so
  // inert cross-role grants can't accumulate.
  const allowed  = new Set(MODULES_BY_ROLE[target.role as ManagedRole])
  const filtered = items.filter((i) => allowed.has(i.module_name))

  const rows = await PermissionsModel.replaceForUser(userId, actorId ?? null, filtered)
  invalidateUserPermissions(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'module_permissions_updated',
    description: `Module permissions updated for user ${userId} (${target.role})`,
  })

  return rows.map(toSummary)
}

// Used by getMe to attach the caller's own module permissions to their session.
export async function getSessionPermissions(userId: string): Promise<ModulePermissionSummary[]> {
  const rows = await PermissionsModel.findByUser(userId)
  return rows.map(toSummary)
}
