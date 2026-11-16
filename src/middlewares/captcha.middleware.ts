import { Request, Response, NextFunction } from 'express'
import { verifyTurnstile, turnstileConfigured, type CaptchaAction } from '../lib/turnstile.js'
import { logSystemThrottled } from '../lib/log-system.js'

/**
 * Captcha gate for a public form: only the landing page's contact form
 * (user 2026-11-16; sign-in and password reset have none). Runs after the rate
 * limiter (so a flood doesn't cost a Cloudflare call per request) and BEFORE
 * validate(), which strips unknown fields: the token travels in the body as
 * `captcha_token` and is removed here so no schema or service ever sees it.
 */

const REQUIRED_MESSAGE = 'Please complete the security check and try again.'
const FAILED_MESSAGE   = 'The security check did not go through. Please try it again.'

export function requireCaptcha(action: CaptchaAction) {
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
