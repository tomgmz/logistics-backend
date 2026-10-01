import { Router, Request, Response } from 'express'
import { globalLimiter } from '../middlewares/rateLimit.middleware.js'
import { getPublicMetrics } from '../services/public/metrics.service.js'
import { logSystem } from '../lib/log-system.js'

/**
 * Unauthenticated, read-only endpoints for the marketing site.
 *
 *   GET /api/public/metrics   aggregate delivery figures for the landing page
 *
 * Aggregates only — nothing here may ever return a record, a name or an id.
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

export default router
