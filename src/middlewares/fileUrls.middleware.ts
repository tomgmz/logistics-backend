import { Request, Response, NextFunction, RequestHandler } from 'express'
import { signFileRefsDeep, refsFromSignedUrlsDeep, FileRefInTextError } from '../lib/storage.js'
import { logSystemError } from '../lib/log-system.js'

/**
 * The two halves of private file storage (see lib/storage.ts):
 *
 *   in:  a signed link of ours in a file field of the JSON body becomes its
 *        `r2://` reference again, so what gets validated and stored is never an
 *        expiring URL (free text keeps a pasted link as text; text starting
 *        with `r2://` is refused with 400);
 *   out: any `r2://` reference in a JSON response becomes a signed link.
 *
 * Mounted once, after the body parser and before the routes, so every route
 * gets both without knowing about storage. A route only ever puts rows in its
 * response that its own access checks allowed, so signing there hands a link
 * to exactly the people who may see the file.
 */
/** Runs the inbound half on req.body; false when it already answered 400. */
function normalizeBody(req: Request, res: Response): boolean {
  if (!req.body || typeof req.body !== 'object') return true
  try {
    req.body = refsFromSignedUrlsDeep(req.body)
    return true
  } catch (err) {
    if (!(err instanceof FileRefInTextError)) throw err
    res.status(400).json({ status: 'error', message: err.message, field: err.field })
    return false
  }
}

/**
 * Multipart bodies are parsed by multer inside the route, after fileUrls has
 * run, so each multer middleware is wrapped to give its text fields the same
 * inbound check. Multer's own errors pass through untouched.
 */
export function withFileUrls(upload: RequestHandler): RequestHandler {
  return (req, res, next) => upload(req, res, (err?: unknown) => {
    if (err) return next(err)
    if (normalizeBody(req, res)) next()
  })
}

export function fileUrls(req: Request, res: Response, next: NextFunction) {
  if (!normalizeBody(req, res)) return

  const json = res.json.bind(res)
  res.json = ((body: unknown) => {
    signFileRefsDeep(body)
      .then((signed) => json(signed))
      .catch((err) => {
        logSystemError('storage.sign', 'external_api', err, { path: req.originalUrl })
        if (!res.headersSent) res.status(500).end()
      })
    return res
  }) as Response['json']

  next()
}
