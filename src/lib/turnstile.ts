import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from './log-system.js'

/**
 * Cloudflare Turnstile: the captcha on the public web forms (contact form,
 * sign-in, forgot password, IT Administrator reset code, reset-password page).
 *
 * The browser widget hands the page a single-use token (valid 300 s); the
 * server spends it here at siteverify, with our secret. Each form names an
 * `action`, and a token is only accepted for the action it was made for, so a
 * token solved on the contact form can't be replayed on sign-in.
 *
 * Env: TURNSTILE_SECRET_KEY. Unset = the check is skipped and System Logs says
 * so once an hour (deploying before the key is set must not stop sign-in).
 * Cloudflare's always-pass test pair for development:
 *   site key 1x00000000000000000000AA, secret 1x0000000000000000000000000000000AA
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS     = 5_000

// The landing page's contact form (user 2026-11-16) and its help assistant's
// AI answers (2026-11-18).
export type CaptchaAction = 'contact' | 'assistant'

export type TurnstileResult =
  /** Token checked and accepted. */
  | { outcome: 'passed' }
  /** Token missing, wrong, spent, expired or for another form. */
  | { outcome: 'failed'; codes: string[] }
  /** Not checked: no secret on the server, or Cloudflare didn't answer. */
  | { outcome: 'skipped'; reason: 'not_configured' | 'unavailable' }

export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY)
}

export async function verifyTurnstile(
  token:  string,
  action: CaptchaAction,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY ?? ''
  if (!secret) {
    logSystemThrottled('turnstile.not-configured', 60 * 60_000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'turnstile.config',
      message:    'TURNSTILE_SECRET_KEY is not set, so the landing page contact form is not checked for bots.',
      metadata:   {},
    })
    return { outcome: 'skipped', reason: 'not_configured' }
  }

  // The visitor's address is not sent (remoteip is optional): company policy
  // keeps IPs out of anything we pass on, and the widget already ran in their
  // browser, which is where Cloudflare judged them.
  const form = new URLSearchParams({ secret, response: token })

  let body: { success?: boolean; action?: string; 'error-codes'?: string[] }
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method:  'POST',
      body:    form,
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Cloudflare answered ${res.status}`)
    body = await res.json() as typeof body
  } catch (err: any) {
    // Fail open: a Cloudflare outage must not lock every client and staff
    // member out of sign-in. The per-account and per-address rate limits
    // still apply to these requests.
    logSystemThrottled('turnstile.verify', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
      log_level:  'error',
      event_type: 'external_api',
      source:     'turnstile.verify',
      message:    `The captcha check could not reach Cloudflare (${err?.message ?? String(err)}), so the form was let through without it.`,
      metadata:   {},
    })
    return { outcome: 'skipped', reason: 'unavailable' }
  }

  const codes = body['error-codes'] ?? []
  // A broken secret is our fault, not the visitor's: fail open and say so.
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    logSystemThrottled('turnstile.secret', 60 * 60_000, {
      log_level:  'error',
      event_type: 'external_api',
      source:     'turnstile.config',
      message:    'Cloudflare refused TURNSTILE_SECRET_KEY (wrong or deleted key), so the public forms are not checked for bots.',
      metadata:   { codes },
    })
    return { outcome: 'skipped', reason: 'not_configured' }
  }

  if (!body.success) return { outcome: 'failed', codes }
  if (body.action && body.action !== action) return { outcome: 'failed', codes: ['action-mismatch'] }
  return { outcome: 'passed' }
}
