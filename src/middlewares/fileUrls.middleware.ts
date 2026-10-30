import { Request, Response, NextFunction } from 'express'
import { signFileRefsDeep, refsFromSignedUrlsDeep } from '../lib/storage.js'
import { logSystemError } from '../lib/log-system.js'

/**
 * The two halves of private file storage (see lib/storage.ts):
 *
 *   in:  any signed link of ours in the JSON body becomes its `r2://` reference
 *        again, so what gets validated and stored is never an expiring URL;
 *   out: any `r2://` reference in a JSON response becomes a signed link.
 *
 * Mounted once, after the body parser and before the routes, so every route
 * gets both without knowing about storage. A route only ever puts rows in its
 * response that its own access checks allowed, so signing there hands a link
 * to exactly the people who may see the file.
 */
export function fileUrls(req: Request, res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') req.body = refsFromSignedUrlsDeep(req.body)

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
