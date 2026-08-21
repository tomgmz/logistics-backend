import { Request, Response, NextFunction } from 'express'
import { isGmApprover } from '../services/notification/notification.service.js'

/**
 * Gate for the GM approval stage.
 *
 * Authority here is not a plain role check: besides the general manager and
 * admins, the IT admin can appoint an accountant as a GM PROXY to keep bookings
 * moving while the GM is unavailable. That appointment lives on the user record
 * (`users.is_gm_proxy`), not in the JWT, so it is read per request — revoking a
 * proxy takes effect immediately instead of waiting for the token to expire.
 */
export async function requireGmApprover(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.sub
    if (!userId) {
      res.status(401).json({ status: 'error', message: 'Not authenticated' })
      return
    }

    // Fast path for the roles that always hold the authority.
    if (req.user?.role === 'general_manager' || req.user?.role === 'admin') return next()

    if (await isGmApprover(userId)) return next()

    res.status(403).json({
      status:  'error',
      message: 'Only the general manager or an appointed proxy can approve bookings',
    })
  } catch (err) {
    console.error('GM APPROVER MIDDLEWARE ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Authorization error' })
  }
}
