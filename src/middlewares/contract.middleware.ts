import { Request, Response, NextFunction } from 'express'
import { contractStatusForUser, contractBookingClosedMessage } from '../lib/contract-status.js'
import { logSystemError } from '../lib/log-system.js'

/**
 * Refuses new booking work (create, edit a pending booking, resubmit a rejected
 * one) from a client whose contract has ended (lib/contract-status, 2026-11-07).
 * Staff pass through untouched; bookings already submitted carry on through
 * their other routes (cancel, confirm completion, report a problem).
 */
export async function requireOpenContract(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'client') return next()
  try {
    const status = await contractStatusForUser(req.user.sub)
    if (status.state === 'ok') return next()
    res.status(403).json({
      status:  'error',
      code:    'CONTRACT_EXPIRED',
      message: contractBookingClosedMessage(status),
      data:    status,
    })
  } catch (err) {
    logSystemError('contract.middleware', 'server_error', err, { user_id: req.user.sub })
    res.status(500).json({ status: 'error', message: 'Could not check the contract. Please try again.' })
  }
}
