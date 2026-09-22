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

export function requestContext(req: Request, res: Response, next: NextFunction) {
  storage.run(
    {
      requestId: (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
      path:      req.originalUrl,
      method:    req.method,
    },
    () => next(),
  )
}

export default requestContext
