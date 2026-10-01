import geoip from 'fast-geoip'
import crypto from 'crypto'
import type { Request } from 'express'

/** How old a forwarded location may be before it is ignored (guards replays). */
const FORWARDED_GEO_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Roughly where THIS request came from, for a security email.
 *
 * Two ways in:
 *  - Straight to the backend (mobile app, the web's direct reset call): req.ip
 *    is the person's own address, so look it up offline.
 *  - Through the web app's Next proxy: req.ip is Vercel's server, which would
 *    put a Philippine user in a US data centre. The proxy sends the visitor's
 *    location instead (Vercel's own geo headers) in X-Client-Geo, signed with
 *    GEO_FORWARD_SECRET so a direct caller cannot pick a reassuring city for an
 *    email that exists to catch them.
 *
 * X-Client-Geo being present at all means "came through the proxy". If the
 * signature does not check out (secret missing on either side, tampering, too
 * old), the answer is null, never a fall-back to req.ip, which is the proxy's
 * address and would be wrong.
 */
export async function describeRequestLocation(req: Request): Promise<string | null> {
  const forwarded = req.get('x-client-geo')
  if (forwarded === undefined) return describeIpLocation(req.ip)
  return verifyForwardedGeo(forwarded, req.get('x-client-geo-sig'))
}

function verifyForwardedGeo(payload: string, signature?: string): string | null {
  const secret = process.env.GEO_FORWARD_SECRET
  if (!secret || !signature) return null

  const expected = crypto.createHmac('sha256', secret).update(payload).digest()
  const given    = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null

  try {
    const geo = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      city?: string | null; country?: string | null; ts?: number
    }
    if (typeof geo.ts !== 'number' || Math.abs(Date.now() - geo.ts) > FORWARDED_GEO_MAX_AGE_MS) return null
    if (!geo.country || !/^[A-Z]{2}$/.test(geo.country)) return null
    const country = countryName(geo.country)
    const city    = typeof geo.city === 'string' ? geo.city.trim().slice(0, 80) : ''
    return city ? `${city}, ${country}` : country
  } catch {
    return null
  }
}

/**
 * Roughly where a request came from, as a place a person recognises:
 * "San Pablo City, Philippines", or just "Philippines" when the city is unknown.
 *
 * Used only to tell an account holder where their password was changed from,
 * instead of showing them a bare IP address. The lookup is OFFLINE (the
 * fast-geoip database ships inside the package), so the address never leaves
 * this process: no third-party geolocation service ever sees it. Neither the
 * IP nor the result is stored or logged. Company policy is that a user's IP is
 * not recorded, and this keeps to that.
 *
 * Returns null whenever there is nothing honest to say: loopback or private
 * addresses (local development, an internal hop), IPv6 (the database is IPv4
 * only), or an address the database does not know. The caller leaves the line
 * out in that case, rather than printing a guess.
 */
export async function describeIpLocation(ip?: string | null): Promise<string | null> {
  if (!ip) return null
  // Express reports IPv4 through an IPv6 stack as ::ffff:1.2.3.4
  const bare = ip.trim().replace(/^::ffff:/i, '')
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || isPrivateIpv4(bare)) return null

  try {
    const info = await geoip.lookup(bare)
    if (!info?.country) return null
    const country = countryName(info.country)
    return info.city ? `${info.city}, ${country}` : country
  } catch {
    // A failed lookup only costs the email one line; it must never fail the reset.
    return null
  }
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)   // carrier-grade NAT
  )
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}
