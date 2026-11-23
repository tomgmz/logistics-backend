import { Request, Response } from 'express'
import * as ResetService from '../../services/auth/password-reset.service.js'
import { describeRequestLocation } from '../../lib/ip-location.js'

// One response for every outcome of a reset request. A caller must not be able to
// tell an unknown address from a real one, a locked account from an active one,
// or a first request from a repeat.
// Covers both routes (link straight away for IT Administrator, Company
// Administrator and General Manager; after approval for everyone else) in one
// sentence, so the reply never says which kind of account the address is.
const NEUTRAL_REQUEST_MESSAGE =
  'If that account exists, a reset link is on its way to it: straight away for IT Administrator, ' +
  'Company Administrator and General Manager accounts, after the IT Administrator approves it for everyone else.'

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
    // The emails say roughly WHERE the reset came from, never the IP. The IP is
    // turned into a place here, offline, and goes no further. See
    // lib/ip-location.ts and completeReset's parameter docs.
    const location = await describeRequestLocation(req)
    await ResetService.completeReset(token, password, location)
    res.status(200).json({
      status:  'success',
      message: 'Your password has been reset. You can now sign in.',
    })
  } catch (err: unknown) {
    const code    = (err as any)?.code
    const message = err instanceof Error ? err.message : 'Failed to reset password'

    if (code === 'RESET_TOKEN_INVALID' || code === 'RESET_ACCOUNT_INACTIVE' || code === 'PASSWORD_UNCHANGED') {
      res.status(400).json({ status: 'error', code, message })
      return
    }

    console.error('PASSWORD RESET ERROR:', err)
    // Never the internal error text (database / provider messages): it would
    // show in the browser's Network tab. The detail stays in the server log.
    res.status(500).json({ status: 'error', message: 'Could not reset your password. Please try again.' })
  }
}
