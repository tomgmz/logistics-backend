import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import * as AuthModel from '../models/auth/auth.model.js'
import { setContextUser } from '../lib/request-context.js'
import { logEvent } from '../lib/log-event.js'
import { logSystem } from '../lib/log-system.js'
import { hashToken } from '../services/auth/auth.service.js'

const JWT_SECRET = process.env.JWT_SECRET!

export interface AuthPayload {
  sub: string
  role: string
  email: string
  type: 'access' | 'refresh'
  iat: number
  exp: number
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
      sessionId?: string
    }
  }
}

//AUTHENTICATION

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    // Idempotent: if an upstream mount already authenticated this request
    // (e.g. /api/admin runs authenticate before moduleGuard), don't redo the
    // session lookup when per-route authenticate runs again.
    if (req.user) return next()

    // Cookie first (web), then Bearer header (API/mobile)
    let token = req.cookies?.access_token

    if (!token) {
      const authHeader = req.headers.authorization
      if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7)
    }

    if (!token) {
      res.status(401).json({ status: 'error', message: 'Missing or invalid authorization' })
      return
    }

    let payload: AuthPayload
    try {
      payload = jwt.verify(token, JWT_SECRET) as AuthPayload
    } catch {
      res.status(401).json({ status: 'error', message: 'Invalid or expired token' })
      return
    }

    if (payload.type !== 'access') {
      res.status(401).json({ status: 'error', message: 'Invalid token type' })
      return
    }

    const tokenHash = hashToken(token)
    const session = await AuthModel.findActiveSession(tokenHash)

    if (!session) {
      res.status(401).json({ status: 'error', message: 'Session expired or revoked' })
      return
    }

    // Entitlement comes from the users row joined onto the session, never from
    // the JWT. A deactivated account stops here on its very next request
    // instead of running out the remaining minutes of its access token, and it
    // holds for every code path that can deactivate someone — including ones
    // that forget to revoke sessions, which is how this gap appeared.
    //
    // A distinct code so the client can say "your access changed, sign in
    // again" rather than showing the generic session-expired bounce.
    if (session.users && session.users.status !== 'active') {
      logEvent({
        user_id:     payload.sub,
        log_type:    'access_control',
        action:      'inactive_account_blocked',
        description: `Request refused: account status is '${session.users.status}'`,
      })
      res.status(401).json({
        status:  'error',
        code:    'ACCOUNT_INACTIVE',
        message: 'Your account is no longer active. Please contact your Administrator.',
      })
      return
    }

    // Fire and forget don't block the request
    AuthModel.refreshSessionLastSeen(session.id).catch(() => {})

    // Same reasoning for the role: a demotion must not keep granting the old
    // role until the token expires, so the database wins over the claim.
    req.user = session.users?.role
      ? { ...payload, role: session.users.role }
      : payload
    req.sessionId = session.id
    // Hand the actor to the ambient request store so logEvent() can attribute
    // rows written deep in a service without every signature carrying a userId.
    setContextUser(payload.sub)
    next()
  } catch (err) {
    console.error('AUTH MIDDLEWARE ERROR:', err)
    logSystem({
      log_level:  'error',
      event_type: 'server_error',
      source:     'auth.middleware',
      message:    (err as Error)?.message ?? 'Authentication middleware failed',
      metadata:   { stack: (err as Error)?.stack },
    })
    res.status(500).json({ status: 'error', message: 'Authentication error' })
  }
}

//OPTIONAL AUTH

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.access_token || req.headers.authorization?.slice(7)

    if (!token) return next()

    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload

    if (payload.type === 'access') {
      const tokenHash = hashToken(token)
      const session = await AuthModel.findActiveSession(tokenHash)

      // Same entitlement rules as authenticate(); an inactive account is
      // simply treated as anonymous here rather than rejected, since these
      // routes work without a user at all.
      if (session && session.users?.status === 'active') {
        req.user = session.users.role
          ? { ...payload, role: session.users.role }
          : payload
        req.sessionId = session.id
        AuthModel.refreshSessionLastSeen(session.id).catch(() => {})
      }
    }

    next()
  } catch {
    next()
  }
}

//AUTHORIZATION

export function authorize(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      // An attempt to reach something you are not entitled to is a business
      // fact, not a technical one, so it belongs in the audit trail: "did
      // anyone try to open billing before we granted it?" is a question the
      // Company Admin asks. Only logged when we know who asked — an
      // unauthenticated caller never got past authenticate().
      if (req.user) {
        logEvent({
          user_id:     req.user.sub,
          log_type:    'access_control',
          action:      'permission_denied',
          description: `${req.user.role} denied ${req.method} ${req.originalUrl} (requires: ${roles.join(', ')})`,
        })
      }
      res.status(403).json({ status: 'error', message: 'Insufficient permissions' })
      return
    }
    next()
  }
}

// Aliassame behaviour as authorize()
export const authorizeAny = authorize

/**
 * Restrict a route to the root administrator — the earliest-created `admin`
 * account, which protected-admin.ts already treats as the one that can never be
 * permission-restricted.
 *
 * Reserved for actions where "any Company Admin" is too wide a blast radius. The
 * IT Admin handover is the first: it retires a privileged account and installs
 * its replacement, and it is deliberately NOT something the outgoing IT Admin can
 * run on themselves.
 *
 * Stack it after authorize('admin') — this checks WHICH admin, not whether the
 * caller is one.
 */
export async function isRootAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { isProtectedAdmin } = await import('../lib/protected-admin.js')

  if (!req.user || !(await isProtectedAdmin(req.user.sub))) {
    res.status(403).json({
      status:  'error',
      message: 'Only the primary Administrator account can perform this action.',
    })
    return
  }
  next()
}

//CSRF

/**
 * Double-submit CSRF check for COOKIE-authenticated requests.
 *
 * This was written, exported, and then never mounted on a single route — the web
 * app dutifully fetched a token and sent the header, and nothing on this side
 * ever looked at it. It is not the only thing standing between the API and a
 * cross-site request (the auth cookies are `sameSite: 'strict'`, so a browser
 * will not attach them to one in the first place), but a defence that exists
 * only in a file nobody calls is not a defence.
 *
 * It applies only where the risk exists. A request authenticated with a Bearer
 * token — the driver app, and any API client — cannot be forged cross-site,
 * because no browser attaches that header on someone else's behalf. Enforcing it
 * there would lock the mobile app out of every write it makes.
 */
export function verifyCsrfToken(req: Request, res: Response, next: NextFunction) {
  // Safe methods don't need CSRF protection
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()

  // Bearer-authenticated callers are not cookie-driven and carry no CSRF risk.
  const usesCookieAuth = !!req.cookies?.access_token
  if (!usesCookieAuth) return next()

  const tokenFromCookie = req.cookies?.csrf_token
  const tokenFromHeader = req.headers['x-csrf-token'] as string

  if (!tokenFromCookie || !tokenFromHeader || tokenFromCookie !== tokenFromHeader) {
    res.status(403).json({ status: 'error', message: 'Invalid or missing CSRF token' })
    return
  }

  next()
}

//IN MEMORY RATE LIMITER

const requestCounts = new Map<string, { count: number; resetAt: number }>()

export function rateLimiter(maxRequests = 100, windowMs = 15 * 60 * 1000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const record = requestCounts.get(ip)

    if (!record || now > record.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + windowMs })
      return next()
    }

    if (record.count >= maxRequests) {
      res.status(429).json({ status: 'error', message: 'Too many requests. Please try again later.' })
      return
    }

    record.count++
    next()
  }
}

// Purge stale records every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, record] of requestCounts.entries()) {
    if (now > record.resetAt) requestCounts.delete(ip)
  }
}, 10 * 60 * 1000)