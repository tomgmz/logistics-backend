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
} from '../constants/modules.js'

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
//   - admin / it_admin            -> never restricted
//   - non-managed roles           -> left to existing role gates
//   - managed role, no rows       -> keep role-default access
//   - managed role, has rows      -> enforce the matrix (missing/insufficient = 403)
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
      res.status(403).json({
        status:  'error',
        message: 'You do not have permission to perform this action on this module.',
      })
      return
    }

    next()
  } catch (err) {
    console.error('MODULE GUARD ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Authorization error' })
  }
}

// Pin module enforcement to a fixed module, for operational routes that live
// outside /api/admin (e.g. booking approve/reject on /api/booking) and so aren't
// covered by moduleForPath. Same bypass/managed/protected rules as moduleGuard;
// the HTTP method still selects the required flag (PATCH/PUT -> can_edit, etc.).
export function requireModule(moduleKey: ModuleKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user
      if (!user) return next() // authenticate handles the 401

      if (isBypassRole(user.role)) return next()
      if (!isManagedRole(user.role)) return next()
      if (await isProtectedAdmin(user.sub)) return next()

      const rows = await getUserPermissions(user.sub)
      if (rows.length === 0) return next() // no custom permissions -> role default

      const requiredFlag = requiredFlagForMethod(req.method)
      if (!requiredFlag) return next()

      const row = rows.find((r) => r.module_name === moduleKey)
      if (!row || !row[requiredFlag]) {
        res.status(403).json({
          status:  'error',
          message: 'You do not have permission to perform this action on this module.',
        })
        return
      }

      next()
    } catch (err) {
      console.error('REQUIRE MODULE ERROR:', err)
      res.status(500).json({ status: 'error', message: 'Authorization error' })
    }
  }
}
