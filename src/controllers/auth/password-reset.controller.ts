import { Request, Response } from 'express'
import * as ResetService from '../../services/auth/password-reset.service.js'

// One response for every outcome of a reset request. A caller must not be able to
// tell an unknown address from a real one, a locked account from an active one,
// or a first request from a repeat.
const NEUTRAL_REQUEST_MESSAGE =
  'If that account exists, your administrator has been notified and will send you a reset link.'

export async function requestReset(req: Request, res: Response) {
  // The service never throws; it logs and returns so that a failure cannot be
  // distinguished from a success by the caller.
  await ResetService.requestPasswordReset({
    email: req.body.email,
    ip:    req.ip ?? null,
  })

  res.status(200).json({ status: 'success', message: NEUTRAL_REQUEST_MESSAGE })
}

export async function verifyToken(req: Request, res: Response) {
  try {
    const result = await ResetService.verifyResetToken(req.body.token)
    res.status(200).json({ status: 'success', data: result })
  } catch (err: unknown) {
    console.error('RESET TOKEN VERIFY ERROR:', err)
    // An unreadable token is an invalid token, not a server problem worth
    // describing to whoever sent it.
    res.status(200).json({ status: 'success', data: { valid: false } })
  }
}

export async function completeReset(req: Request, res: Response) {
  try {
    const { token, password } = req.body
    await ResetService.completeReset(token, password)
    res.status(200).json({
      status:  'success',
      message: 'Your password has been reset. You can now sign in.',
    })
  } catch (err: unknown) {
    const code    = (err as any)?.code
    const message = err instanceof Error ? err.message : 'Failed to reset password'

    if (code === 'RESET_TOKEN_INVALID' || code === 'RESET_ACCOUNT_INACTIVE') {
      res.status(400).json({ status: 'error', code, message })
      return
    }

    console.error('PASSWORD RESET ERROR:', err)
    res.status(500).json({ status: 'error', message })
  }
}
