import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
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
      csrfToken?: string
    }
  }
}
//AUTHENTICATION MIDDLEWARE

// AUTHENTICATE USER HEADER BASED AND HTTP ONLY COOKIE
export async function authenticate(
  req: Request, 
  res: Response, 
  next: NextFunction
) {
  try {
    // Try cookie first (web app), then Authorization header (API/mobile)
    let token = req.cookies?.access_token
    
    if (!token) {
      const authHeader = req.headers.authorization
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7)
      }
    }

    if (!token) {
      res.status(401).json({ 
        status: 'error', 
        message: 'Missing or invalid authorization' 
      })
      return
    }

    // Verify JWT
    let payload: AuthPayload
    try {
      payload = jwt.verify(token, JWT_SECRET) as AuthPayload
    } catch {
      res.status(401).json({ 
        status: 'error', 
        message: 'Invalid or expired token' 
      })
      return
    }

    // Must be access token
    if (payload.type !== 'access') {
      res.status(401).json({ 
        status: 'error', 
        message: 'Invalid token type' 
      })
      return
    }

    // Hash token and verify session exists in DB
    const tokenHash = hashToken(token)
    const session = await AuthModel.findActiveSession(tokenHash)
    
    if (!session) {
      res.status(401).json({ 
        status: 'error', 
        message: 'Session expired or revoked' 
      })
      return
    }

    // Update last activity (fire and forget)
    AuthModel.refreshSessionLastSeen(session.id).catch(() => {})

    req.user = payload
    req.sessionId = session.id
    next()
  } catch (err) {
    console.error('AUTH MIDDLEWARE ERROR:', err)
    res.status(500).json({ 
      status: 'error', 
      message: 'Authentication error' 
    })
  }
}

//OPTIONAL AUTH
export async function optionalAuth(
  req: Request, 
  res: Response, 
  next: NextFunction
) {
  try {
    const token = req.cookies?.access_token || req.headers.authorization?.slice(7)

    if (!token) {
      next()
      return
    }

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
    // Silent fail for optional auth
    next()
  }
}
//ROLE BASED AUTHORIZATION

export function authorize(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ 
        status: 'error', 
        message: 'Insufficient permissions' 
      })
      return
    }
    next()
  }
}

//ROLE CHECKING
export function authorizeAny(...roles: string[]) {
  return authorize(...roles)
}

export function authorizeAll(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(403).json({ 
        status: 'error', 
        message: 'Insufficient permissions' 
      })
      return
    }

    const hasAllRoles = roles.every(role => req.user!.role === role)
    
    if (!hasAllRoles) {
      res.status(403).json({ 
        status: 'error', 
        message: 'Insufficient permissions' 
      })
      return
    }
    
    next()
  }
}
//CSRF OPERATIONS

//GENERATE CSRF TOKEN
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

//CSRF TOKEN IN COOKIE
export function setCsrfToken(
  req: Request, 
  res: Response, 
  next: NextFunction
) {
  const token = generateCsrfToken()
  
  res.cookie('csrf_token', token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,  // 24 hours
  })

  req.csrfToken = token
  next()
}

//VERIFY CSRF TOKEN
export function verifyCsrfToken(
  req: Request, 
  res: Response, 
  next: NextFunction
) {
  // Skip for GET/HEAD/OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next()
    return
  }

  const tokenFromCookie = req.cookies?.csrf_token
  const tokenFromHeader = req.headers['x-csrf-token'] as string

  if (!tokenFromCookie || !tokenFromHeader || tokenFromCookie !== tokenFromHeader) {
    res.status(403).json({ 
      status: 'error', 
      message: 'Invalid or missing CSRF token' 
    })
    return
  }

  next()
}
//RATE LIMIT- IP BASED

const requestCounts = new Map<string, { count: number; resetAt: number }>()

//MEMORY RATE LIMITER
export function rateLimiter(maxRequests: number = 100, windowMs: number = 15 * 60 * 1000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.socket.remoteAddress || 'unknown'
    const now = Date.now()

    const record = requestCounts.get(ip)

    if (!record || now > record.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    if (record.count >= maxRequests) {
      res.status(429).json({ 
        status: 'error', 
        message: 'Too many requests. Please try again later.' 
      })
      return
    }

    record.count++
    next()
  }
}

// Cleanup old rate limit records every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, record] of requestCounts.entries()) {
    if (now > record.resetAt) {
      requestCounts.delete(ip)
    }
  }
}, 10 * 60 * 1000)