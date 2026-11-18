import { Router, Request, Response } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { logSystemThrottled } from '../lib/log-system.js'
import { handleDeliveryEvent, fromResendEvent, ResendWebhookEvent } from '../services/notification/email-delivery.service.js'

/**
 * Callbacks from outside services. No session and no CSRF (mounted ahead of
 * verifyCsrfToken): each route proves the caller itself.
 *
 * POST /api/webhooks/resend — Resend's delivery events (the email provider
 *   since 2026-11-18). Set up in Resend: Webhooks → Add endpoint, URL
 *   https://api.8338logistics.delivery/api/webhooks/resend, events
 *   email.bounced, email.failed, email.suppressed, email.complained,
 *   email.delivery_delayed. Its signing secret (whsec_…) goes in
 *   RESEND_WEBHOOK_SECRET. Requests are signed the Svix way: HMAC-SHA256 of
 *   "<svix-id>.<svix-timestamp>.<raw body>" with the base64 secret.
 *
 * (POST /api/webhooks/brevo was removed with Brevo on 2026-11-18.)
 */
const router = Router()

// ── Resend ─────────────────────────────────────────────────────────────────

/** How old a signed request may be: Svix's own libraries use 5 minutes. */
const RESEND_TOLERANCE_S = 5 * 60

function resendSignatureOk(req: Request, secret: string): boolean {
  const id   = req.get('svix-id') ?? ''
  const ts   = req.get('svix-timestamp') ?? ''
  const sigs = req.get('svix-signature') ?? ''
  const raw  = (req as unknown as { rawBody?: Buffer }).rawBody
  if (!id || !ts || !sigs || !raw) return false

  // An old (replayed) or future-dated request is refused.
  const t = Number(ts)
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > RESEND_TOLERANCE_S) return false

  const key      = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${ts}.`).update(raw).digest()
  // The header can carry several "v1,<base64>" signatures (key rotation).
  return sigs.split(' ').some((part) => {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) return false
    const given = Buffer.from(sig, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

router.post('/resend', (req: Request, res: Response) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? ''
  if (!secret) {
    logSystemThrottled('resend-webhook:unset', 60 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'email_event',
      source:     'resend.webhook',
      message:    'Resend sent a delivery event but RESEND_WEBHOOK_SECRET is not set on the server, so it was ignored.',
    })
    res.status(503).json({ status: 'error', message: 'Webhook not configured' })
    return
  }
  if (!resendSignatureOk(req, secret)) {
    logSystemThrottled('resend-webhook:auth', 10 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'auth_event',
      source:     'resend.webhook',
      message:    'A call to the Resend webhook had a missing, old or wrong signature and was refused.',
    })
    res.status(401).json({ status: 'error', message: 'Unauthorized' })
    return
  }

  // Answer first so Resend never retries because we were slow; the handler never throws.
  const ev = req.body as ResendWebhookEvent | undefined
  const svixId = req.get('svix-id') ?? ''
  res.status(200).json({ status: 'ok' })
  void (async () => {
    for (const one of fromResendEvent(ev, svixId)) await handleDeliveryEvent(one)
  })()
})

export default router
