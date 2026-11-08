import { Router, type NextFunction, type Request, type Response } from 'express'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'

import { GRANT_TTL_SEC, idMatches, makeGrant, openGrant, unseal } from '../lib/file-links.js'
import { contentTypeFor, openFile } from '../lib/storage.js'
import { allowedOrigins } from '../lib/allowed-origins.js'
import { logSystemError } from '../lib/log-system.js'
import { authenticate, verifyCsrfToken } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'

/**
 * GET /api/files/:id/:name?t=<sealed>  — streams one stored file behind a
 * sealed link (lib/file-links.ts), so the storage URL is never sent to the
 * browser or the app.
 *
 * Since 2026-11-08 the sealed link alone opens nothing (a copied link is
 * useless): the request must also carry EITHER
 *   - the session of the account the link was issued to (the driver app sends
 *     its Bearer token with every image), OR
 *   - `g=<pass>`: a single-use, 60-second web pass from POST /api/files/grants.
 *     The web's session cookie is sealed by Next and only its proxy can show
 *     it, and files are too big to stream through Vercel, so the browser asks
 *     the proxy for a pass and then fetches the file from the API directly.
 */
const router = Router()

/** Passes already used, until they expire (single use). Per server instance. */
const usedPasses = new Map<string, number>()
function purgeUsedPasses(nowSec: number) {
  for (const [nonce, exp] of usedPasses) if (exp < nowSec) usedPasses.delete(nonce)
}

/** A pass in the query skips the session check (it is checked in the handler); otherwise a session is required. */
function sessionUnlessPass(req: Request, res: Response, next: NextFunction) {
  if (typeof req.query.g === 'string' && req.query.g) return next()
  return authenticate(req, res, next)
}

/** Shown in the page (an <img>, <video> or PDF frame); anything else downloads. SVG can carry script, so it downloads. */
function isInline(type: string): boolean {
  return /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/.test(type)
    || type === 'application/pdf'
    || /^video\//.test(type)
}

function notFound(res: Response) {
  res.status(404).json({ status: 'error', message: 'This file link is not valid. Refresh the page to get a new one.' })
}

function notYours(res: Response) {
  res.status(403).json({ status: 'error', code: 'FILE_LINK_NOT_YOURS', message: 'This file link was issued to another account.' })
}

/**
 * POST /api/files/grants  { links: string[] }  →  { grants: { [link]: string | null } }
 * One single-use 60-second pass per link, only for links issued to the
 * signed-in user (or to nobody in particular). The web batches its requests.
 */
router.post('/grants', authenticate, authenticatedLimiter, verifyCsrfToken, (req: Request, res: Response) => {
  const links: unknown = req.body?.links
  if (!Array.isArray(links) || links.length === 0 || links.length > 100) {
    return res.status(400).json({ status: 'error', message: 'Send 1 to 100 file links.' })
  }
  const me  = req.user!.sub
  const now = Math.floor(Date.now() / 1000)
  const grants: Record<string, string | null> = {}
  for (const link of links) {
    if (typeof link !== 'string') continue
    grants[link] = null
    try {
      const url    = new URL(link)
      const sealed = unseal(url.searchParams.get('t') ?? '')
      if (!sealed || sealed.expiresAtSec <= now) continue
      if (sealed.userId && sealed.userId !== me) continue
      url.searchParams.set('g', makeGrant(sealed.key, me, randomUUID()))
      grants[link] = url.toString()
    } catch { /* not a link; stays null */ }
  }
  res.json({ status: 'success', data: { grants, ttl_seconds: GRANT_TTL_SEC } })
})

router.get('/:id/:name', sessionUnlessPass, async (req: Request, res: Response) => {
  const token  = typeof req.query.t === 'string' ? req.query.t : ''
  const sealed = token ? unseal(token) : null
  const id     = String(req.params.id ?? '')
  if (!sealed || !idMatches(id, sealed.key)) return notFound(res)

  const nowSec = Math.floor(Date.now() / 1000)
  const left   = sealed.expiresAtSec - nowSec
  if (left <= 0) {
    return res.status(410).json({ status: 'error', code: 'FILE_LINK_EXPIRED', message: 'This file link has expired. Refresh the page to get a new one.' })
  }

  // Who is asking: a web pass (single use) or the session authenticate() checked.
  const passToken = typeof req.query.g === 'string' ? req.query.g : ''
  if (passToken) {
    const pass = openGrant(passToken)
    if (!pass || pass.key !== sealed.key || pass.expiresAtSec < nowSec) {
      return res.status(401).json({ status: 'error', code: 'FILE_PASS_INVALID', message: 'This file pass has expired. Open the file again from the page.' })
    }
    if (sealed.userId && pass.userId !== sealed.userId) return notYours(res)
    purgeUsedPasses(nowSec)
    if (usedPasses.has(pass.nonce)) {
      return res.status(401).json({ status: 'error', code: 'FILE_PASS_USED', message: 'This file pass was already used. Open the file again from the page.' })
    }
    usedPasses.set(pass.nonce, pass.expiresAtSec)
  } else if (sealed.userId && req.user?.sub !== sealed.userId) {
    return notYours(res)
  }

  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
  let obj: Awaited<ReturnType<typeof openFile>>
  try {
    obj = await openFile(sealed.key, range)
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'NoSuchKey' || name === 'NotFound') return notFound(res)
    if (name === 'InvalidRange') return res.status(416).end()
    logSystemError('storage.read', 'external_api', err, { path: '/api/files' })
    return res.status(502).json({ status: 'error', message: 'The file could not be loaded. Try again.' })
  }

  const fileName = sealed.key.split('/').pop() || 'file'
  const ext      = fileName.includes('.') ? fileName.split('.').pop()! : ''
  const type     = obj.ContentType || contentTypeFor(ext)
  const inline   = isInline(type)
  const ascii    = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')

  res.status(obj.ContentRange ? 206 : 200)
  res.setHeader('Content-Type', type)
  if (obj.ContentLength != null) res.setHeader('Content-Length', String(obj.ContentLength))
  if (obj.ContentRange) res.setHeader('Content-Range', obj.ContentRange)
  res.setHeader('Accept-Ranges', 'bytes')
  if (obj.ETag) res.setHeader('ETag', obj.ETag)
  if (obj.LastModified) res.setHeader('Last-Modified', obj.LastModified.toUTCString())
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  // A pass is single use, so nothing is kept for it; the app's image cache may
  // keep a session-loaded copy, never past the link's own expiry.
  res.setHeader('Cache-Control', passToken ? 'no-store' : `private, max-age=${left}`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // The web may frame a PDF; nobody else may. Nothing served here may run script.
  res.removeHeader('X-Frame-Options')
  const ancestors = `frame-ancestors 'self' ${allowedOrigins.join(' ')}`
  res.setHeader('Content-Security-Policy', type === 'application/pdf'
    ? ancestors
    : `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox; ${ancestors}`)

  if (req.method === 'HEAD' || !obj.Body) return res.end()
  try {
    await pipeline(obj.Body as Readable, res)
  } catch {
    // The viewer closed / the video seeked: the browser dropped the connection.
    if (!res.headersSent) res.status(502).end()
  }
})

export default router
