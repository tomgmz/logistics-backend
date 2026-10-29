import crypto from 'crypto'
import type { Request } from 'express'

/** How old a forwarded address may be before it is ignored (guards replays). */
const FORWARDED_IP_MAX_AGE_MS = 5 * 60 * 1000

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
 * Requests through the web app's Next proxy connect from Vercel's servers, so
 * that address is Vercel's and every web visitor would share one rate-limit
 * bucket. The proxy therefore sends the visitor's own address in X-Client-Ip,
 * signed with GEO_FORWARD_SECRET (see the frontend's lib/server/ip-forward.ts).
 * It is only believed when the signature checks out and is fresh; anything
 * else falls back to the connecting address, so a direct caller cannot pick
 * its own rate-limit key.
 *
 * Used in memory only (rate-limit keys, the location lookup). Company policy:
 * a user's IP is never stored or logged.
 */
export function clientIp(req: Request): string {
  return forwardedClientIp(req) || req.get('x-real-ip')?.trim() || req.ip || '::1'
}

function forwardedClientIp(req: Request): string | null {
  const payload   = req.get('x-client-ip')
  const signature = req.get('x-client-ip-sig')
  const secret    = process.env.GEO_FORWARD_SECRET
  if (!payload || !signature || !secret) return null

  const expected = crypto.createHmac('sha256', secret).update(`ip:${payload}`).digest()
  const given    = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null

  try {
    const { ip, ts } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { ip?: unknown; ts?: unknown }
    if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > FORWARDED_IP_MAX_AGE_MS) return null
    if (typeof ip !== 'string' || !/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return null
    return ip
  } catch {
    return null
  }
}
