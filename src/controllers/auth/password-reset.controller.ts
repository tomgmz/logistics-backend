import { Request, Response } from 'express'
import * as ResetService from '../../services/auth/password-reset.service.js'

// One response for every outcome of a reset request. A caller must not be able to
// tell an unknown address from a real one, a locked account from an active one,
// or a first request from a repeat.
const NEUTRAL_REQUEST_MESSAGE =
  'If that account exists, your administrator has been notified and will send you a reset link.'

// The same idea for the IT Admin's code: one answer for a sent code, an address
// with no account, an address belonging to somebody who is not the IT Admin, a
// deactivated account, and a resend inside the cooldown. The endpoint must not
// become a way to ask which mailbox administers the system.
const NEUTRAL_OTP_MESSAGE =
  'If that address belongs to an IT Admin account, a 6-digit code is on its way to it.'

export async function requestReset(req: Request, res: Response) {
  // The service never throws; it logs and returns so that a failure cannot be
  // distinguished from a success by the caller.
  await ResetService.requestPasswordReset({
    email: req.body.email,
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

/**
 * Email an IT Admin a self-service reset code.
 *
 * Separate from requestReset above because it is a different product rule, not a
 * variation of one: everyone else waits for an admin to press Send, and the IT
 * Admin cannot, because the queue they would be waiting on is their own.
 */
export async function requestOtp(req: Request, res: Response) {
  // Never throws, for the same reason requestReset's service never throws.
  await ResetService.requestItAdminOtp({
    email: req.body.email,
  })

  res.status(200).json({ status: 'success', message: NEUTRAL_OTP_MESSAGE })
}

/**
 * Trade a correct code for a one-time reset token.
 *
 * The token is the same kind the emailed link carries, so the caller finishes at
 * /auth/reset-password exactly as a link recipient does. Handing back a token
 * rather than accepting a new password here is what keeps one completion path -
 * and it means the code itself never travels alongside a password.
 */
export async function verifyOtp(req: Request, res: Response) {
  try {
    const { email, code } = req.body
    const result = await ResetService.verifyItAdminOtp({ email, code })

    res.status(200).json({ status: 'success', data: result })
  } catch (err: unknown) {
    const code    = (err as any)?.code
    const message = err instanceof Error ? err.message : 'Could not verify that code'

    if (
      code === 'RESET_OTP_INVALID'   ||
      code === 'RESET_OTP_INCORRECT' ||
      code === 'RESET_OTP_EXHAUSTED'
    ) {
      res.status(400).json({ status: 'error', code, message })
      return
    }

    console.error('PASSWORD RESET OTP VERIFY ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Could not verify that code' })
  }
}
