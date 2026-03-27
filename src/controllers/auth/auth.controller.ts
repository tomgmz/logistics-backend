import { Request, Response } from 'express'
import * as AuthService from '../../services/auth/auth.service.js'
import { hashToken } from '../../services/auth/auth.service.js'

export async function requestOtp(req: Request, res: Response) {
  try {
    await AuthService.requestOtp(req.body)
    res.status(200).json({
      status:  'success',
      message: 'If that email is registered, a login code has been sent.',
    })
  } catch (err: any) {
    console.error('OTP REQUEST ERROR:', {
      message:   err?.message,
      stack:     err?.stack,
      body:      req.body,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({ status: 'error', message: 'Failed to send code' })
  }
}

export async function verifyOtp(req: Request, res: Response) {
  try {
    const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                      ?? req.socket.remoteAddress
                      ?? undefined

    const data = await AuthService.verifyOtp(req.body, ipAddress)
    res.status(200).json({ status: 'success', data })
  } catch {
    res.status(401).json({ status: 'error', message: 'Invalid or expired code' })
  }
}

export async function logout(req: Request, res: Response) {
  try {
    const token = req.headers.authorization?.slice(7) ?? ''
    // ✅ Hash before passing — consistent with how it was stored
    await AuthService.logout(hashToken(token))
    res.status(200).json({ status: 'success', message: 'Logged out successfully' })
  } catch {
    res.status(500).json({ status: 'error', message: 'Logout failed' })
  }
}

export async function me(req: Request, res: Response) {
  res.status(200).json({ status: 'success', data: req.user })
}