import { Router, Request, Response } from 'express'
import { globalLimiter, contactFormLimiter } from '../middlewares/rateLimit.middleware.js'
import { validate } from '../middlewares/validate.middleware.js'
import { getPublicMetrics } from '../services/public/metrics.service.js'
import { logSystem } from '../lib/log-system.js'
import { sendContactInquiryEmail } from '../lib/brevo-mailer.js'
import { contactInquirySchema, type ContactInquiryInput } from '../schema/public/contact.schema.js'

/**
 * Unauthenticated, read-only endpoints for the marketing site.
 *
 *   GET  /api/public/metrics   aggregate delivery figures for the landing page
 *   POST /api/public/contact   the landing page's contact form, emailed to the company inbox
 *
 * Aggregates only — nothing here may ever return a record, a name or an id.
 * The contact form only sends; it stores nothing and returns nothing back.
 */

const router = Router()

router.get('/metrics', globalLimiter, async (_req: Request, res: Response) => {
  try {
    const data = await getPublicMetrics()
    res.set('Cache-Control', 'public, max-age=300')
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    logSystem({
      log_level:  'error',
      event_type: 'server_error',
      source:     'public.metrics',
      message:    (err as Error)?.message ?? 'Failed to compute public metrics',
    })
    res.status(500).json({ status: 'error', message: 'Metrics are unavailable right now.' })
  }
})

router.post('/contact', contactFormLimiter, validate(contactInquirySchema), async (req: Request, res: Response) => {
  const body = req.body as ContactInquiryInput

  // A filled honeypot is a bot. Answer exactly as for a real message so it
  // learns nothing, but send nothing.
  if (body.website && body.website.trim() !== '') {
    res.status(200).json({ status: 'success', message: 'Message sent.' })
    return
  }

  try {
    await sendContactInquiryEmail({
      firstName: body.first_name,
      lastName:  body.last_name,
      email:     body.email,
      phone:     body.phone ?? null,
      role:      body.role,
      message:   body.message,
    })
    res.status(200).json({ status: 'success', message: 'Message sent.' })
  } catch {
    // The mailer already wrote the system log with Brevo's reason.
    res.status(502).json({
      status:  'error',
      message: 'We could not send your message right now. Please try again, or email or call us directly.',
    })
  }
})

export default router
