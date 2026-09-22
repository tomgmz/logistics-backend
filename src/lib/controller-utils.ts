import { Request } from 'express'

/**
 * Actor for the audit trail.
 *
 * This used to return the caller's IP alongside the user id, and every
 * controller dutifully passed it down to its service — which then dropped it.
 * Company privacy rules forbid recording where a user connected from, so the
 * field is gone at the source rather than collected and discarded: there is
 * nothing to leak and nothing for a later change to start persisting by
 * accident.
 *
 * Correlating a log line back to a single request is handled by the request id
 * in lib/request-context.ts, which identifies the request, not the person.
 */
export function getRequestMeta(req: Request): { userId: string | null } {
  return {
    userId: req.user?.sub ?? null,
  }
}

export function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value
}
