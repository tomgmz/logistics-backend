import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { createHash } from 'crypto'

/**
 * Every limiter answers in the app's error shape, never the library's default.
 *
 * express-rate-limit replies with PLAIN TEXT unless told otherwise, and every
 * client here reads `response.data.message`. Against a text body that is
 * undefined, so the user was shown axios's own string — "Request failed with
 * status code 429" — which tells them nothing and reads like a crash. A limit
 * that is hit should say what happened in a sentence someone can act on.
 */
const limitMessage = (message: string) => ({ status: 'error', message })

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? '::1'),
  message: limitMessage('Too many requests from this network. Please try again in a few minutes.'),
})

/**
 * The ceiling for ordinary signed-in use — nearly every authenticated route in
 * the system shares it.
 *
 * It is a backstop against a runaway client, NOT a quota on working. It used to
 * be 100 per 15 minutes, which sounds generous until you notice this single
 * budget covers ~70 route usages across billing, bookings, driver, notifications,
 * uploads, directions and history: a screen that loads half a dozen endpoints
 * spends it in fifteen screens, and the app then starts refusing the user their
 * own data mid-shift. That is a broken app, not a protected one — and it is what
 * a driver hit simply by opening bookings a few times.
 *
 * At this budget a person cannot reach the limit by using the product; only a
 * loop can, and a loop reaches it quickly. Abuse that actually needs a tight
 * ceiling — signing in, resetting a password, raising an emergency — has its own
 * limiter below, sized for that specific risk.
 */
export const authenticatedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? '::1'),
  message: limitMessage('Too many requests. Please wait a moment and try again.'),
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
  message: limitMessage('Position updates are coming in too fast. Tracking will resume shortly.'),
})

/**
 * The SOS quick alert, and anything else that raises an emergency.
 *
 * Carved out of `authenticatedLimiter` because that budget — 100 requests per
 * 15 minutes across every driver route — is spent by ORDINARY use: opening
 * bookings, reading trips, pulling the reports list. A driver who has been
 * working normally for a quarter of an hour can arrive at an emergency with
 * nothing left, and be told "too many requests" by the one call in this system
 * that must never be refused.
 *
 * The ceiling is high enough that no genuine emergency can reach it — nobody
 * files thirty incidents in fifteen minutes — and low enough to stop a handset
 * stuck in a send loop from flooding the responders' notifications. Keyed per
 * user, so one device cannot spend the fleet's allowance.
 */
export const emergencyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? '::1'),
  message: limitMessage('Several alerts have already been sent from this device. If this is still an emergency, call dispatch directly.'),
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

/**
 * Passkey enrolment (verify-invite, options, verify).
 *
 * Keyed on the enrolment token for the same reason `passwordResetLimiter` is:
 * these bodies carry a token and no email, so an IP key would pool every driver
 * behind one vendor's office connection into a single budget. A subcontractor
 * setting up on site should not be locked out because a colleague did it first.
 *
 * The budget is generous because one legitimate enrolment is several requests —
 * verify the invite, fetch options, submit the response — and a driver who
 * fumbles the biometric prompt will repeat the last two.
 */
export const passkeyEnrollLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = req.body?.token
    if (token && typeof token === 'string') {
      return 'pk:' + createHash('sha256').update(token).digest('hex').slice(0, 32)
    }
    return ipKeyGenerator(req.ip ?? '::1')
  },
  message: { status: 'error', message: 'Too many attempts on this setup link. Please try again later.' },
})

/**
 * Passkey sign-in (options + verify).
 *
 * Necessarily per-IP: a discoverable-credential sign-in sends no email and no
 * token — that is the point, it is what removes the enumeration surface — so
 * there is nothing else to key on. Sized for a shared vendor yard rather than a
 * single handset, since several drivers may sign in from the same connection at
 * the start of a shift.
 */
export const passkeyAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? '::1'),
  message: { status: 'error', message: 'Too many sign-in attempts. Please try again in a few minutes.' },
})
