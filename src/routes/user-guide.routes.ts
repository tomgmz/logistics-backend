import { Router, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticate } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'

/**
 * GET /api/user-guide — the user guide PDF for the signed-in person's role,
 * for the driver app's in-app User Guide screen (2026-11-28). The web keeps its
 * own cookie-checked route (logistics-frontend src/app/user-guide/route.ts),
 * because a browser tab can't send the Bearer token this one needs.
 *
 * The role is the one `authenticate` read from the database (not the token
 * claim), so a demoted account never gets its old role's guide. Fixed list,
 * so the role never builds a path; a role with no guide gets a 404, never
 * someone else's guide.
 *
 * ETag: the app keeps a copy for no-signal use and asks with If-None-Match, so
 * an unchanged guide costs a 304 instead of the whole PDF on weak signal.
 *
 * To update: rebuild the guides (t:\CP\docs\user-guide\roles\build_roles.py
 * writes t:\CP\User Guides) and copy each PDF to assets/user-guides/<role>.pdf
 * here AND to logistics-frontend/private/user-guides/<role>.pdf.
 */

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/user-guides')

const GUIDE_ROLES = new Set([
  'it_admin', 'admin', 'general_manager', 'operations_manager', 'fleet_manager', 'client', 'driver',
])

const LABELS: Record<string, string> = {
  it_admin:           'IT Administrator',
  admin:              'Company Administrator',
  general_manager:    'General Manager',
  operations_manager: 'Operations Manager',
  fleet_manager:      'Fleet Manager',
  client:             'Client',
  driver:             'Driver',
}

/** Read once per process: the files only change with a deploy. */
const cache = new Map<string, { pdf: Buffer; etag: string }>()

async function load(role: string) {
  const hit = cache.get(role)
  if (hit) return hit
  const pdf  = await readFile(path.join(DIR, `${role}.pdf`))
  const etag = `"${createHash('sha256').update(pdf).digest('base64url').slice(0, 27)}"`
  const entry = { pdf, etag }
  cache.set(role, entry)
  return entry
}

const router = Router()

router.get('/', authenticate, authenticatedLimiter, async (req: Request, res: Response) => {
  const role = req.user!.role
  if (!GUIDE_ROLES.has(role)) {
    res.status(404).json({ status: 'error', message: 'There is no user guide for your role yet.' })
    return
  }

  let entry: { pdf: Buffer; etag: string }
  try {
    entry = await load(role)
  } catch (err) {
    console.error(`[user-guide] ${role}.pdf missing from the build`, err)
    res.status(503).json({ status: 'error', message: 'The user guide is not available right now.' })
    return
  }

  // Private: never kept by a shared cache. no-cache = the app always asks, but
  // an unchanged guide is only a 304.
  res.setHeader('Cache-Control', 'private, no-cache')
  res.setHeader('ETag', entry.etag)
  res.setHeader('X-Robots-Tag', 'noindex')
  if (req.headers['if-none-match'] === entry.etag) {
    res.status(304).end()
    return
  }

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="8338 User Guide - ${LABELS[role]}.pdf"`)
  res.setHeader('Content-Length', String(entry.pdf.length))
  res.status(200).end(entry.pdf)
})

export default router
