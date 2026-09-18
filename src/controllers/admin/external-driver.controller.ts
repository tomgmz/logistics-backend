import { Request, Response } from 'express'
import * as EnrollmentService from '../../services/auth/driver-enrollment.service.js'

/**
 * Admin actions on a vendor-supplied driver's app access.
 *
 * Deliberately only three: resend the setup link, revoke everything, and look at
 * the current state. Anything more (editing the account, resetting a password)
 * either does not apply to a passkey-only account or belongs on the assignment
 * that created it.
 */

export async function getAccessStatus(req: Request, res: Response) {
  try {
    const status = await EnrollmentService.externalDriverAccessStatus(String(req.params.userId))
    res.status(200).json({ status: 'success', data: status })
  } catch (err: any) {
    console.error('EXTERNAL DRIVER STATUS ERROR:', err)
    res.status(400).json({ status: 'error', message: err?.message ?? 'Could not load access status.' })
  }
}

export async function reinvite(req: Request, res: Response) {
  try {
    await EnrollmentService.reinvite(String(req.params.userId), req.user?.sub ?? null)
    res.status(200).json({ status: 'success', message: 'Setup link sent.' })
  } catch (err: any) {
    console.error('EXTERNAL DRIVER REINVITE ERROR:', err)
    res.status(400).json({ status: 'error', message: err?.message ?? 'Could not send the setup link.' })
  }
}

export async function revoke(req: Request, res: Response) {
  try {
    const result = await EnrollmentService.revokeExternalDriver(
      String(req.params.userId),
      req.user?.sub ?? null,
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 200)
        : 'Revoked by administrator',
    )
    res.status(200).json({
      status:  'success',
      message: `Access revoked (${result.credentialsRevoked} passkey(s)).`,
      data:    result,
    })
  } catch (err: any) {
    console.error('EXTERNAL DRIVER REVOKE ERROR:', err)
    res.status(400).json({ status: 'error', message: err?.message ?? 'Could not revoke access.' })
  }
}
