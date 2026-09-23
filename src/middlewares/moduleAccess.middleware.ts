import { Request, Response, NextFunction } from 'express'
import * as PermissionsModel from '../models/admin/permissions.model.js'
import { ModulePermissionRow } from '../types/permissions.types.js'
import { isProtectedAdmin } from '../lib/protected-admin.js'
import {
  isBypassRole,
  isManagedRole,
  moduleForPath,
  requiredFlagForMethod,
  ModuleKey,
  ModulePermissionFlags,
} from '../constants/modules.js'
import { logEvent } from '../lib/log-event.js'
import { logSystem } from '../lib/log-system.js'

// Small per-user TTL cache so we don't hit the DB on every admin request.
const CACHE_TTL_MS = 30 * 1000
const cache = new Map<string, { expires: number; rows: ModulePermissionRow[] }>()

async function getUserPermissions(userId: string): Promise<ModulePermissionRow[]> {
  const hit = cache.get(userId)
  if (hit && hit.expires > Date.now()) return hit.rows

  const rows = await PermissionsModel.findByUser(userId)
  cache.set(userId, { expires: Date.now() + CACHE_TTL_MS, rows })
  return rows
}

// Call after a permission change so the new rules take effect immediately.
export function invalidateUserPermissions(userId: string): void {
  cache.delete(userId)
}

// Enforces per-module access on the /api/admin router. Runs AFTER authenticate,
// so req.user is populated. Bypass + managed-role logic per the RBAC plan:
//   - it_admin                    -> never restricted (BYPASS_ROLES); it runs the
//                                    permission panel, so it must not be lockable
//   - root administrator          -> never restricted, whatever its rows say
//   - other non-managed roles     -> left to existing role gates
//   - managed role, no rows       -> keep role-default access
//   - managed role, has rows      -> enforce the matrix (missing/insufficient = 403)
//
// `admin` IS a managed role — see MANAGED_ROLES in constants/modules.ts. This
// comment used to pair it with it_admin as "never restricted", which is wrong
// and is the sort of thing someone reads when deciding whether a permission
// actually bites. Only the root administrator is exempt among admins, via the
// isProtectedAdmin check below.
export async function moduleGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user
    if (!user) return next() // authenticate handles the 401

    if (isBypassRole(user.role)) return next()
    if (!isManagedRole(user.role)) return next()

    // The root administrator is never restricted.
    if (await isProtectedAdmin(user.sub)) return next()

    const moduleKey = moduleForPath(req.path)
    if (!moduleKey) return next()

    const rows = await getUserPermissions(user.sub)
    if (rows.length === 0) return next() // no custom permissions -> role default

    const requiredFlag = requiredFlagForMethod(req.method)
    if (!requiredFlag) return next()

    const row = rows.find((r) => r.module_name === moduleKey)
    if (!row || !row[requiredFlag]) {
      // Audit, not system: who was refused which module is a governance fact.
      logEvent({
        user_id:     user.sub,
        log_type:    'access_control',
        action:      'module_access_denied',
        description: `${user.role} denied ${requiredFlag} on ${moduleKey} (${req.method} ${req.originalUrl})`,
      })
      res.status(403).json({
        status:  'error',
        message: 'You do not have permission to perform this action on this module.',
      })
      return
    }

    next()
  } catch (err) {
    console.error('MODULE GUARD ERROR:', err)
    logSystem({
      log_level:  'error',
      event_type: 'server_error',
      source:     'moduleAccess.moduleGuard',
      message:    (err as Error)?.message ?? 'Authorization check failed',
      metadata:   { stack: (err as Error)?.stack },
    })
    res.status(500).json({ status: 'error', message: 'Authorization error' })
  }
}

// The shared body behind requireModule and requireModuleFlag. `resolveFlag`
// decides which permission the request needs: normally that follows from the
// HTTP method, but can_export has no method of its own and has to be named.
// Returning null from it means "nothing to enforce here", same as before.
function moduleFlagGate(
  moduleKey: ModuleKey,
  resolveFlag: (req: Request) => keyof ModulePermissionFlags | null,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user
      if (!user) return next() // authenticate handles the 401

      if (isBypassRole(user.role)) return next()
      if (!isManagedRole(user.role)) return next()
      if (await isProtectedAdmin(user.sub)) return next()

      const rows = await getUserPermissions(user.sub)
      if (rows.length === 0) return next() // no custom permissions -> role default

      const requiredFlag = resolveFlag(req)
      if (!requiredFlag) return next()

      const row = rows.find((r) => r.module_name === moduleKey)
      if (!row || !row[requiredFlag]) {
        logEvent({
          user_id:     user.sub,
          log_type:    'access_control',
          action:      'module_access_denied',
          description: `${user.role} denied ${requiredFlag} on ${moduleKey} (${req.method} ${req.originalUrl})`,
        })
        res.status(403).json({
          status:  'error',
          message: 'You do not have permission to perform this action on this module.',
        })
        return
      }

      next()
    } catch (err) {
      console.error('REQUIRE MODULE ERROR:', err)
    logSystem({
      log_level:  'error',
      event_type: 'server_error',
      source:     'moduleAccess.requireModule',
      message:    (err as Error)?.message ?? 'Authorization check failed',
      metadata:   { stack: (err as Error)?.stack },
    })
      res.status(500).json({ status: 'error', message: 'Authorization error' })
    }
  }
}

// Pin module enforcement to a fixed module, for operational routes that live
// outside /api/admin (e.g. booking approve/reject on /api/booking) and so aren't
// covered by moduleForPath. Same bypass/managed/protected rules as moduleGuard;
// the HTTP method still selects the required flag (PATCH/PUT -> can_edit, etc.).
export function requireModule(moduleKey: ModuleKey) {
  return moduleFlagGate(moduleKey, (req) => requiredFlagForMethod(req.method))
}

// Enforce one named flag regardless of method. `can_export` is the reason this
// exists: an export is a GET, and requiredFlagForMethod maps every GET to
// can_view, so the export flag the IT Admin sets in the permission matrix was
// never actually checked anywhere. Use this on any route whose required
// permission does not follow from its verb.
export function requireModuleFlag(
  moduleKey: ModuleKey,
  flag: keyof ModulePermissionFlags,
) {
  return moduleFlagGate(moduleKey, () => flag)
}
