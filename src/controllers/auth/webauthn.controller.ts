import { Request, Response } from 'express'
import * as WebauthnService from '../../services/auth/webauthn.service.js'

/**
 * Passkey endpoints.
 *
 * Mobile-only in practice, so — like every other driver-facing auth route — the
 * tokens come back in the JSON body rather than as cookies. The app stores them
 * in SecureStore and sends them as a Bearer header, which is why CSRF does not
 * apply to this path.
 */

function deviceInfoOf(req: Request): string | undefined {
  return (req.body?.device_info as string | undefined) ?? req.headers['user-agent']
}

export async function verifyInvite(req: Request, res: Response) {
  try {
    const result = await WebauthnService.verifyInvite(req.body.token)
    res.status(200).json({ status: 'success', data: result })
  } catch (err: unknown) {
    // Never distinguishes a bad token from a server problem, so this stays free
    // of an oracle even when something genuinely breaks.
    console.error('PASSKEY VERIFY INVITE ERROR:', err)
    res.status(200).json({ status: 'success', data: { valid: false } })
  }
}

export async function enrollOptions(req: Request, res: Response) {
  try {
    const options = await WebauthnService.startRegistration(req.body.token)
    res.status(200).json({ status: 'success', data: options })
  } catch (err: any) {
    // A server with no RP ID configured is not the driver's problem and is not a
    // bad link — it deserves its own status so it is distinguishable in a log.
    if (err?.code === 'PASSKEY_NOT_CONFIGURED') {
      console.error('PASSKEY ENROLL OPTIONS — NOT CONFIGURED:', err.message)
      res.status(503).json({
        status:  'error',
        message: 'Passkey setup is unavailable on this server. Please contact your administrator.',
      })
      return
    }
    if (err?.code === 'ENROLLMENT_TOKEN_INVALID') {
      res.status(400).json({ status: 'error', message: err.message })
      return
    }
    console.error('PASSKEY ENROLL OPTIONS ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Could not start passkey setup. Please try again.' })
  }
}

export async function enrollVerify(req: Request, res: Response) {
  try {
    const auth = await WebauthnService.finishRegistration(
      req.body.token,
      req.body.credential,
      deviceInfoOf(req),
      req.body.device_label ?? null,
    )
    res.status(200).json({
      status: 'success',
      data: {
        user:         auth.user,
        expiresAt:    auth.accessExpiresAt,
        accessToken:  auth.accessToken,
        refreshToken: auth.refreshToken,
      },
    })
  } catch (err: any) {
    if (err?.code === 'PASSKEY_NOT_CONFIGURED') {
      console.error('PASSKEY ENROLL VERIFY — NOT CONFIGURED:', err.message)
      res.status(503).json({
        status:  'error',
        message: 'Passkey setup is unavailable on this server. Please contact your administrator.',
      })
      return
    }
    console.error('PASSKEY ENROLL VERIFY ERROR:', err)
    res.status(400).json({
      status:  'error',
      message: err?.message ?? 'Could not complete passkey setup.',
    })
  }
}

export async function authOptions(req: Request, res: Response) {
  try {
    const options = await WebauthnService.startAuthentication()
    res.status(200).json({ status: 'success', data: options })
  } catch (err: unknown) {
    console.error('PASSKEY AUTH OPTIONS ERROR:', err)
    res.status(503).json({ status: 'error', message: 'Passkey sign-in is unavailable.' })
  }
}

export async function authVerify(req: Request, res: Response) {
  try {
    const auth = await WebauthnService.finishAuthentication(req.body.credential, deviceInfoOf(req))
    res.status(200).json({
      status: 'success',
      data: {
        user:         auth.user,
        expiresAt:    auth.accessExpiresAt,
        accessToken:  auth.accessToken,
        refreshToken: auth.refreshToken,
      },
    })
  } catch (err: any) {
    res.status(401).json({
      status:  'error',
      message: err?.message ?? 'Could not sign you in with that passkey.',
    })
  }
}

export async function listMine(req: Request, res: Response) {
  try {
    const rows = await WebauthnService.listMyPasskeys(req.user!.sub)
    res.status(200).json({ status: 'success', data: rows })
  } catch (err: unknown) {
    console.error('PASSKEY LIST ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Could not load your passkeys.' })
  }
}

export async function removeMine(req: Request, res: Response) {
  try {
    await WebauthnService.removeMyPasskey(req.user!.sub, String(req.params.credentialPk))
    res.status(200).json({ status: 'success' })
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err?.message ?? 'Could not remove that passkey.' })
  }
}
