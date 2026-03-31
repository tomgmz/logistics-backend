import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import * as AuthModel from '../models/auth/auth.model.js'
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

    // Fire and forget don't block the request
    AuthModel.refreshSessionLastSeen(session.id).catch(() => {})

    req.user = payload
    req.sessionId = session.id
    next()
  } catch (err) {
    console.error('AUTH MIDDLEWARE ERROR:', err)
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

      if (session) {
        req.user = payload
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
      res.status(403).json({ status: 'error', message: 'Insufficient permissions' })
      return
    }
    next()
  }
}

// Aliassame behaviour as authorize()
export const authorizeAny = authorize

//CSRF

export function verifyCsrfToken(req: Request, res: Response, next: NextFunction) {
  // Safe methods don't need CSRF protection
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()

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