import { Request, Response, NextFunction } from 'express'
import { verifyTurnstile, turnstileConfigured, type CaptchaAction } from '../lib/turnstile.js'
import { logSystemThrottled } from '../lib/log-system.js'
import * as AuthModel from '../models/auth/auth.model.js'
import * as ResetModel from '../models/auth/password-reset.model.js'
import { hashToken } from '../services/auth/auth.service.js'

/**
 * Captcha gate for a public form. Runs after the rate limiters (so a flood
 * doesn't cost a Cloudflare call per request) and BEFORE validate(), which
 * strips unknown fields: the token travels in the body as `captcha_token` and
 * is removed here so no schema or service ever sees it.
 *
 * The driver app can't run the web widget, so a request with NO token is let
 * through only when `appExempt` says the account is a driver (the app is
 * driver-only). Clients, staff and unknown addresses always need the token.
 * A script pretending to be the app can therefore only reach driver accounts,
 * which keep the per-account rate limits. Closing that fully needs Play
 * Integrity / App Attest in a native build.
 */

type AppExempt = (req: Request) => Promise<boolean>

const REQUIRED_MESSAGE = 'Please complete the security check and try again.'
const FAILED_MESSAGE   = 'The security check did not go through. Please try it again.'

export function requireCaptcha(action: CaptchaAction, appExempt?: AppExempt) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const body  = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {}
    const token = typeof body.captcha_token === 'string' ? body.captcha_token.trim() : ''
    delete body.captcha_token

    // Not set up on this server: nothing to check (verifyTurnstile logs it).
    if (!turnstileConfigured()) {
      await verifyTurnstile('', action)
      next()
      return
    }

    if (!token) {
      let exempt = false
      try { exempt = appExempt ? await appExempt(req) : false } catch { exempt = false }
      if (exempt) { next(); return }
      res.status(400).json({ status: 'error', code: 'CAPTCHA_REQUIRED', message: REQUIRED_MESSAGE })
      return
    }

    const result = await verifyTurnstile(token.slice(0, 2048), action)
    if (result.outcome === 'failed') {
      logSystemThrottled(`turnstile.failed:${action}`, 60_000, {
        log_level:  'info',
        event_type: 'auth_event',
        source:     'turnstile.failed',
        message:    `A ${action.replace(/_/g, ' ')} request was refused: the captcha did not pass (${result.codes.join(', ') || 'no reason given'}).`,
        metadata:   { action, codes: result.codes },
      })
      res.status(400).json({ status: 'error', code: 'CAPTCHA_FAILED', message: FAILED_MESSAGE })
      return
    }
    next()
  }
}

// ── App exemptions ─────────────────────────────────────────────────────────

/** The body's email belongs to a driver account. */
export const driverByEmail: AppExempt = async (req) => {
  const raw = (req.body as any)?.email
  if (typeof raw !== 'string' || raw.length > 320) return false
  const user = await AuthModel.findUserByEmail(raw.trim().toLowerCase())
  return user?.role === 'driver'
}

/** The reset link in the body was sent to a driver account. */
export const driverByResetToken: AppExempt = async (req) => {
  const raw = (req.body as any)?.token
  if (typeof raw !== 'string' || raw.length > 512) return false
  const request = await ResetModel.findLiveByTokenHash(hashToken(raw))
  if (!request?.email) return false
  const user = await AuthModel.findUserByEmail(String(request.email).trim().toLowerCase())
  return user?.role === 'driver'
}
