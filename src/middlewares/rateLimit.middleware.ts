import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { createHash } from 'crypto'

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? '::1'),
})

export const authenticatedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? '::1'),
})

/**
 * Position pings, which are far too frequent for `authenticatedLimiter`.
 *
 * A driver approaching a stop sends one every 5 s — 180 in the window, against
 * that limiter's ceiling of 100 for everything a session does. This budget is
 * that worst case with room for reconnect bursts, and still low enough to stop a
 * device stuck in a send loop. Keyed per user, so one bad handset cannot spend
 * the fleet's allowance.
 */
export const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? '::1'),
})

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body?.email
    if (email && typeof email === 'string') return email.toLowerCase().trim()
    return ipKeyGenerator(req.ip ?? '::1')
  },
  message: { status: 'error', message: 'Too many requests, please try again later.' },
})
/**
 * Password reset link endpoints (verify + complete).
 *
 * These carry a token, never an email, so `authLimiter` fell back to keying them
 * by IP — and its 10-per-15-minutes then covered every reset happening behind
 * that address. The reset page verifies the token on mount, so ten page loads
 * exhausted it and the user was locked out of finishing their own reset, in some
 * cases after they had already typed a new password. Behind office NAT or
 * carrier CGNAT, ten was the budget for the entire building.
 *
 * Keying on the token fixes both: a shared address no longer pools, because each
 * person holds a different link. Guessing is not what this defends against — the
 * token is 256 bits of CSPRNG and cannot be brute-forced at any request rate —
 * so the ceiling only has to stop a loop hammering the endpoint.
 *
 * The key is a hash of the token, so the reset secret is not sitting in the
 * limiter's in-memory store as a lookup key.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = req.body?.token
    if (token && typeof token === 'string') {
      return 'tok:' + createHash('sha256').update(token).digest('hex').slice(0, 32)
    }
    return ipKeyGenerator(req.ip ?? '::1')
  },
  message: { status: 'error', message: 'Too many attempts on this reset link. Please try again later.' },
})

/**
 * A per-IP ceiling for raising reset requests, stacked on top of the per-email
 * `authLimiter`.
 *
 * Keying only by email meant one address could fire an unlimited number of
 * requests as long as each named a different account — enough to put a pending
 * request and a notification fan-out against every staff address someone knows.
 * The open-request index and the re-notify cooldown bound the damage, but
 * nothing bounded the traffic. This does, while staying well clear of a genuine
 * office where several people are locked out at once.
 */
export const resetRequestIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? '::1'),
  message: { status: 'error', message: 'Too many requests, please try again later.' },
})
