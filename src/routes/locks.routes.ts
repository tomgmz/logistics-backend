import { Router, Request, Response, NextFunction } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { requireModuleFlag } from '../middlewares/moduleAccess.middleware.js'
import type { ModuleKey } from '../constants/modules.js'
import {
  acquireLock,
  getLock,
  isLockType,
  isMissingLockInfra,
  listActiveLocks,
  releaseLock,
  toView,
  type LockType,
} from '../lib/record-lock.js'

/**
 * Screen-side record locks — see lib/record-lock.ts for the model.
 *
 *   GET    /api/locks/:type         live locks of a type (list badges)
 *   GET    /api/locks/:type/:id     one record's lock + write_seq
 *   POST   /api/locks/:type/:id     acquire or renew (heartbeat)
 *   DELETE /api/locks/:type/:id     release your own lock
 *
 * Staff only. A client or driver has no editing screen that competes with
 * staff; their writes are still serialised by the write guard on the routes
 * themselves.
 */

const router = Router()

const isStaff = authorize('admin', 'it_admin', 'fleet_manager', 'general_manager', 'operations_manager')

// Taking a lock blocks everyone else, so it takes the same edit permission as
// the writes it protects. Otherwise a read-only viewer who merely opened a
// record would lock out the people allowed to change it.
const MODULE_OF: Partial<Record<LockType, ModuleKey>> = {
  booking:         'booking-management',
  truck:           'vehicle-management',
  truck_model:     'vehicle-management',
  password_reset:  'user-management',
  handling_code:   'system-maintenance',
  commodity:       'system-maintenance',
  product:         'system-maintenance',
  landline_prefix: 'system-maintenance',
  // 'user' spans user-management (staff) and vehicle-management (drivers), and
  // 'driver_report' belongs to the crewing roles; both rely on the role gate.
}

function lockType(req: Request, res: Response, next: NextFunction) {
  if (!isLockType(String(req.params.type))) {
    res.status(404).json({ status: 'error', message: 'Unknown record type' })
    return
  }
  next()
}

function canEditType(req: Request, res: Response, next: NextFunction) {
  const moduleKey = MODULE_OF[req.params.type as LockType]
  if (!moduleKey) return next()
  return requireModuleFlag(moduleKey, 'can_edit')(req, res, next)
}

/** Lock infra missing → report "unlocked" so screens stay usable. */
function unavailable(res: Response, type: LockType, id: string) {
  res.json({
    status: 'success',
    data: {
      resource_type: type, resource_id: id, locked: false, held_by_me: false,
      holder_name: null, expires_at: null, write_seq: 0, last_write_by_me: false,
      unavailable: true,
    },
  })
}

router.use(authenticate, isStaff, authenticatedLimiter)

router.get('/:type', lockType, async (req, res, next) => {
  const type = req.params.type as LockType
  try {
    const rows = await listActiveLocks(type)
    res.json({
      status: 'success',
      data: rows.map((r) => toView(type, r.resource_id, r, req.user!.sub)),
    })
  } catch (err) {
    if (isMissingLockInfra(err)) { res.json({ status: 'success', data: [] }); return }
    next(err)
  }
})

router.get('/:type/:id', lockType, async (req, res, next) => {
  const type = req.params.type as LockType
  const id   = String(req.params.id)
  try {
    const state = await getLock(type, id)
    res.json({ status: 'success', data: toView(type, id, state, req.user!.sub) })
  } catch (err) {
    if (isMissingLockInfra(err)) return unavailable(res, type, id)
    next(err)
  }
})

router.post('/:type/:id', lockType, canEditType, async (req, res, next) => {
  const type = req.params.type as LockType
  const id   = String(req.params.id)
  try {
    const state = await acquireLock(type, id, req.user!.sub)
    // Not an error when someone else holds it: the screen needs the holder's
    // name to render its banner, and 200 + held_by_me:false carries it.
    res.json({ status: 'success', data: toView(type, id, state, req.user!.sub) })
  } catch (err) {
    if (isMissingLockInfra(err)) return unavailable(res, type, id)
    next(err)
  }
})

router.delete('/:type/:id', lockType, async (req, res, next) => {
  const type = req.params.type as LockType
  const id   = String(req.params.id)
  try {
    await releaseLock(type, id, req.user!.sub)
    res.json({ status: 'success' })
  } catch (err) {
    if (isMissingLockInfra(err)) { res.json({ status: 'success' }); return }
    next(err)
  }
})

export default router
