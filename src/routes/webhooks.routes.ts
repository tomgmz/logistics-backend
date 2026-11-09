import { Router, Request, Response } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { logSystemThrottled } from '../lib/log-system.js'
import { handleDeliveryEvent, BrevoDeliveryEvent } from '../services/notification/email-delivery.service.js'

/**
 * Callbacks from outside services. No session and no CSRF (mounted ahead of
 * verifyCsrfToken): each route proves the caller with its own shared secret.
 *
 * POST /api/webhooks/brevo  — Brevo's transactional delivery events.
 *   Set up in Brevo: Transactional → Settings → Webhook, URL
 *   https://api.8338logistics.delivery/api/webhooks/brevo?token=<BREVO_WEBHOOK_SECRET>
 *   events: Hard bounce, Soft bounce, Blocked, Invalid email, Error, Spam.
 *   The secret may also come as a Bearer token or as the Basic-auth password,
 *   whichever Brevo's form offers.
 */
const router = Router()

function sha(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

function givenSecret(req: Request): string {
  const q = req.query.token
  if (typeof q === 'string' && q) return q
  const auth = req.get('authorization') ?? ''
  if (/^bearer /i.test(auth)) return auth.slice(7).trim()
  if (/^basic /i.test(auth)) {
    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8')
    const i = decoded.indexOf(':')
    return i >= 0 ? decoded.slice(i + 1) : decoded
  }
  return ''
}

router.post('/brevo', (req: Request, res: Response) => {
  const secret = process.env.BREVO_WEBHOOK_SECRET ?? ''
  if (!secret) {
    logSystemThrottled('brevo-webhook:unset', 60 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'email_event',
      source:     'brevo.webhook',
      message:    'Brevo sent a delivery event but BREVO_WEBHOOK_SECRET is not set on the server, so it was ignored.',
    })
    res.status(503).json({ status: 'error', message: 'Webhook not configured' })
    return
  }
  // Compare digests: equal length, constant time, whatever was sent.
  if (!timingSafeEqual(sha(givenSecret(req)), sha(secret))) {
    logSystemThrottled('brevo-webhook:auth', 10 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'auth_event',
      source:     'brevo.webhook',
      message:    'A call to the Brevo webhook had a missing or wrong secret and was refused.',
    })
    res.status(401).json({ status: 'error', message: 'Unauthorized' })
    return
  }

  // One event per call, or a batch. Answer first so Brevo never retries
  // because we were slow; the handler never throws.
  const body = req.body as BrevoDeliveryEvent | BrevoDeliveryEvent[] | undefined
  const events = (Array.isArray(body) ? body : body ? [body] : []).slice(0, 200)
  res.status(200).json({ status: 'ok' })
  void (async () => {
    for (const ev of events) {
      if (ev && typeof ev === 'object') await handleDeliveryEvent(ev)
    }
  })()
})

export default router
