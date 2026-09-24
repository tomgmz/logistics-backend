import { Request, Response, NextFunction } from 'express'
import { isGmApprover } from '../services/notification/notification.service.js'

/**
 * Gate for the GM approval stage.
 *
 * The general manager owns this stage, with admins as the standing fallback so
 * approvals never stall when the GM is away. Authority is read per request
 * rather than from the JWT, so a change in role or status takes effect
 * immediately instead of waiting for the token to expire.
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
      message: 'Only the general manager can approve bookings',
    })
  } catch (err) {
    console.error('GM APPROVER MIDDLEWARE ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Authorization error' })
  }
}
