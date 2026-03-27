import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import * as AuthModel from '../models/auth/auth.model.js'
import { hashToken } from '../services/auth/auth.service.js'

const JWT_SECRET = process.env.JWT_SECRET!

export interface AuthPayload {
  sub:   string
  role:  string
  email: string
  iat:   number
  exp:   number
}

declare global {
  namespace Express {
    interface Request {
      user?:      AuthPayload
      sessionId?: string
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ status: 'error', message: 'Missing or invalid authorization header' })
      return
    }

    const token = authHeader.slice(7)

    let payload: AuthPayload
    try {
      payload = jwt.verify(token, JWT_SECRET) as AuthPayload
    } catch {
      res.status(401).json({ status: 'error', message: 'Invalid or expired token' })
      return
    }

    //HASH TOKEN
    const tokenHash = hashToken(token)
    const session = await AuthModel.findActiveSession(tokenHash)
    if (!session) {
      res.status(401).json({ status: 'error', message: 'Session expired or revoked' })
      return
    }

    AuthModel.refreshSessionLastSeen(session.id).catch(() => {})

    req.user      = payload
    req.sessionId = session.id
    next()
  } catch {
    res.status(500).json({ status: 'error', message: 'Authentication error' })
  }
}

export function authorize(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ status: 'error', message: 'Insufficient permissions' })
      return
    }
    next()
  }
}