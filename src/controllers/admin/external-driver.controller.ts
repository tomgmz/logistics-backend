import { Request, Response } from 'express'
import * as EnrollmentService from '../../services/auth/driver-enrollment.service.js'

/**
 * Admin actions on a vendor-supplied driver's app access.
 *
 * Deliberately few: send the optional passkey setup link and look at the
 * current state. Everything else (editing, Activate / Deactivate / Archive,
 * password resets) goes through the same paths as a company driver; there is
 * no separate Revoke / Restore since 2026-11-11.
 */

export async function list(_req: Request, res: Response) {
  try {
    const drivers = await EnrollmentService.listExternalDrivers()
    res.status(200).json({ status: 'success', data: drivers })
  } catch (err: any) {
    console.error('EXTERNAL DRIVER LIST ERROR:', err)
    res.status(400).json({ status: 'error', message: err?.message ?? 'Could not load vendor drivers.' })
  }
}

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
