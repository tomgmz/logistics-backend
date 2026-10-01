import type { Request } from 'express'

/**
 * The address that actually connected, as Railway's edge saw it.
 *
 * Not req.ip: with `trust proxy` 1 that is the right-most X-Forwarded-For
 * entry, and Railway's edge/CDN layer can put its OWN address there. That is
 * how a password reset made in the Philippines was emailed as "near Brazil",
 * and it also meant rate limits could be keyed on a shared edge address:
 * unrelated users throttled together, an abuser spread across several.
 * Railway overwrites X-Real-IP with the connecting address at its edge, so a
 * client cannot set it. Locally there is no edge and no header, and req.ip is
 * already right.
 *
 * Used in memory only (rate-limit keys, the location lookup). Company policy:
 * a user's IP is never stored or logged.
 */
export function clientIp(req: Request): string {
  return req.get('x-real-ip')?.trim() || req.ip || '::1'
}
