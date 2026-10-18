import { AsyncLocalStorage } from 'node:async_hooks'
import { Request, Response, NextFunction } from 'express'

/**
 * Per-request ambient context for the loggers.
 *
 * Deliberately carries NO IP address and no other network identifier. Company
 * privacy rules forbid recording where a user connected from, so the loggers
 * have nothing to record even if a future call site asks for it — the field
 * does not exist rather than being left blank for someone to "fix" later.
 *
 * What it does carry is a request id, path and method: correlation handles for
 * tying a log line back to one request, none of which identify a person. The
 * user id is here because attribution is the entire point of an audit trail,
 * and it is an internal id the company already holds.
 *
 * Threading `req` down to ~60 logEvent call sites buried in services would mean
 * changing every service signature. AsyncLocalStorage carries this out of band
 * instead: the middleware opens a store per request and the loggers read from
 * it. Anything outside a request (schedulers, startup) gets undefined.
 */
export interface RequestContext {
  userId?:    string
  requestId?: string
  path?:      string
  method?:    string
  /**
   * Server clock minus the phone's clock at the moment the phone sent this
   * request (its `X-Device-Time` header). Times the phone recorded earlier —
   * a tap queued offline, a pause, a photo — are corrected by it: see
   * lib/device-clock. Undefined when the caller sent no such header (web).
   */
  deviceSkewMs?: number
}

const storage = new AsyncLocalStorage<RequestContext>()

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

/** Mutates the live store. Used by authenticate() once the token is decoded. */
export function setContextUser(userId: string): void {
  const store = storage.getStore()
  if (store) store.userId = userId
}

/** A phone a week or more off is not a skewed clock but a broken header. */
const MAX_SKEW_MS = 7 * 24 * 60 * 60 * 1000

function skewFrom(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return undefined
  const device = Date.parse(raw)
  if (!Number.isFinite(device)) return undefined
  const skew = Date.now() - device
  return Math.abs(skew) <= MAX_SKEW_MS ? skew : undefined
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  storage.run(
    {
      requestId: (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
      path:      req.originalUrl,
      method:    req.method,
      deviceSkewMs: skewFrom(req.headers['x-device-time']),
    },
    () => next(),
  )
}

export default requestContext
