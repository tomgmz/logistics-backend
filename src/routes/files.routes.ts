import { Router, type Request, type Response } from 'express'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { idMatches, unseal } from '../lib/file-links.js'
import { contentTypeFor, openFile } from '../lib/storage.js'
import { allowedOrigins } from '../lib/allowed-origins.js'
import { logSystemError } from '../lib/log-system.js'

/**
 * GET /api/files/:id/:name?t=<sealed>  — streams one stored file behind a
 * sealed link (lib/file-links.ts), so the storage URL is never sent to the
 * browser or the app.
 *
 * No session check, on purpose: the sealed token is the permission (an <img>
 * or the driver app's image cache can't attach one), exactly as the R2 signed
 * links were. It is only handed out by routes whose access checks allowed the
 * row, it can't be forged or edited (AES-GCM), and it expires.
 */
const router = Router()

/** Shown in the page (an <img>, <video> or PDF frame); anything else downloads. SVG can carry script, so it downloads. */
function isInline(type: string): boolean {
  return /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/.test(type)
    || type === 'application/pdf'
    || /^video\//.test(type)
}

function notFound(res: Response) {
  res.status(404).json({ status: 'error', message: 'This file link is not valid. Refresh the page to get a new one.' })
}

router.get('/:id/:name', async (req: Request, res: Response) => {
  const token  = typeof req.query.t === 'string' ? req.query.t : ''
  const sealed = token ? unseal(token) : null
  const id     = String(req.params.id ?? '')
  if (!sealed || !idMatches(id, sealed.key)) return notFound(res)

  const left = sealed.expiresAtSec - Math.floor(Date.now() / 1000)
  if (left <= 0) {
    return res.status(410).json({ status: 'error', code: 'FILE_LINK_EXPIRED', message: 'This file link has expired. Refresh the page to get a new one.' })
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
  // Cached by this browser only, and never past the link's own expiry.
  res.setHeader('Cache-Control', `private, max-age=${left}`)
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
