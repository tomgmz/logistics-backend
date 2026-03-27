import { Request, Response } from 'express'
import * as AuthService from '../../services/auth/auth.service.js'
import { hashToken } from '../../services/auth/auth.service.js'
import crypto from 'crypto'

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  path: '/',
}

const ACCESS_COOKIE_OPTIONS = {
  ...COOKIE_OPTIONS,
  maxAge: 15 * 60 * 1000,
}

const REFRESH_COOKIE_OPTIONS = {
  ...COOKIE_OPTIONS,
  maxAge: 7 * 24 * 60 * 60 * 1000,
}

function clearAuthCookies(res: Response) {
  res.clearCookie('access_token', COOKIE_OPTIONS)
  res.clearCookie('refresh_token', COOKIE_OPTIONS)
}

export function getCsrfToken(req: Request, res: Response) {
  const token = crypto.randomBytes(32).toString('hex')

  res.cookie('csrf_token', token, {
    httpOnly: false,
    secure: true,
    sameSite: 'lax' as const,
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  })

  res.status(200).json({ status: 'success' })
}

export async function requestOtp(req: Request, res: Response) {
  try {
    const ipAddress = getIpAddress(req)
    await AuthService.requestOtp(req.body, ipAddress)
    res.status(200).json({
      status: 'success',
      message: 'If that email is registered, a login code has been sent.',
    })
  } catch (err: any) {
    console.error('OTP REQUEST ERROR:', {
      message: err?.message,
      stack: err?.stack,
      body: req.body,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({
      status: 'error',
      message: 'Failed to send code',
    })
  }
}

export async function verifyOtp(req: Request, res: Response) {
  try {
    const ipAddress = getIpAddress(req)
    const userAgent = req.headers['user-agent']

    const data = await AuthService.verifyOtp(req.body, ipAddress, userAgent)

    res.cookie('access_token', data.accessToken, ACCESS_COOKIE_OPTIONS)
    res.cookie('refresh_token', data.refreshToken, REFRESH_COOKIE_OPTIONS)

    res.status(200).json({
      status: 'success',
      data: {
        user: data.user,
        expiresAt: data.accessExpiresAt,
      },
    })
  } catch (err: any) {
    console.error('OTP VERIFICATION ERROR:', err)
    res.status(401).json({
      status: 'error',
      message: err.message || 'Invalid or expired code',
    })
  }
}

export async function refreshToken(req: Request, res: Response) {
  try {
    const token = req.cookies.refresh_token

    if (!token) {
      res.status(401).json({
        status: 'error',
        message: 'No refresh token provided',
      })
      return
    }

    const data = await AuthService.refreshAccessToken(token)

    res.cookie('access_token', data.accessToken, ACCESS_COOKIE_OPTIONS)

    res.status(200).json({
      status: 'success',
      data: {
        expiresAt: data.accessExpiresAt,
      },
    })
  } catch (err: any) {
    console.error('TOKEN REFRESH ERROR:', err)
    clearAuthCookies(res)
    res.status(401).json({
      status: 'error',
      message: 'Session expired. Please log in again.',
    })
  }
}

export async function logout(req: Request, res: Response) {
  try {
    const token = req.cookies.access_token

    if (token) {
      const tokenHash = hashToken(token)
      await AuthService.logout(tokenHash)
    }

    clearAuthCookies(res)

    res.status(200).json({
      status: 'success',
      message: 'Logged out successfully',
    })
  } catch (err) {
    console.error('LOGOUT ERROR:', err)
    res.status(500).json({
      status: 'error',
      message: 'Logout failed',
    })
  }
}

export async function logoutAll(req: Request, res: Response) {
  try {
    if (!req.user) {
      res.status(401).json({
        status: 'error',
        message: 'Not authenticated',
      })
      return
    }

    await AuthService.logoutAll(req.user.sub)

    clearAuthCookies(res)

    res.status(200).json({
      status: 'success',
      message: 'Logged out from all devices',
    })
  } catch (err) {
    console.error('LOGOUT ALL ERROR:', err)
    res.status(500).json({
      status: 'error',
      message: 'Failed to logout from all devices',
    })
  }
}

export async function me(req: Request, res: Response) {
  res.status(200).json({
    status: 'success',
    data: req.user,
  })
}

function getIpAddress(req: Request): string | undefined {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
    (req.headers['x-real-ip'] as string) ??
    req.socket.remoteAddress ??
    undefined
  )
}