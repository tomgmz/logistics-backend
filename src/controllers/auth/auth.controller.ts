import { Request, Response } from 'express'
import * as AuthService from '../../services/auth/auth.service.js'
import { hashToken } from '../../services/auth/auth.service.js'
import crypto from 'crypto'

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PRODUCTION,
  sameSite: 'strict' as const,
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
    secure: IS_PRODUCTION,
    sameSite: 'strict' as const,
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  })
  res.status(200).json({ status: 'success' })
}

export async function getAuthStatus(req: Request, res: Response) {
  try {
    const { email } = req.body
    const status = await AuthService.getAuthStatus(email)
    res.status(200).json({ status: 'success', data: status })
  } catch (err: unknown) {
    console.error('AUTH STATUS ERROR:', err)
    res.status(200).json({ status: 'success', data: { locked: false } })
  }
}

export async function requestOtp(req: Request, res: Response) {
  try {
    await AuthService.requestOtp(req.body)
    res.status(200).json({
      status: 'success',
      message: 'If that email is registered, a login code has been sent.',
    })
  } catch (err: unknown) {
    // Cooldown: user requested OTP too soon — tell the frontend how long to wait
    if (err instanceof Error && (err as any).code === 'OTP_COOLDOWN') {
      res.status(429).json({
        status: 'error',
        code: 'OTP_COOLDOWN',
        retryAfter: (err as any).retryAfter, // seconds — use this to drive the resend timer on the frontend
        message: err.message,
      })
      return
    }

    const message = err instanceof Error ? err.message : 'Failed to send code'
    console.error('OTP REQUEST ERROR:', {
      message,
      body: { email: req.body?.email },
      timestamp: new Date().toISOString(),
      error: err,
    })
    res.status(500).json({
      status: 'error',
      message: 'Failed to send code. Please check your email address and try again.',
    })
  }
}

export async function verifyOtp(req: Request, res: Response) {
  try {
    const userAgent = req.headers['user-agent']
    const data = await AuthService.verifyOtp(req.body, userAgent)

    const isMobile = req.body.platform === 'mobile'
    if (!isMobile) {
      res.cookie('access_token',  data.accessToken,  ACCESS_COOKIE_OPTIONS)
      res.cookie('refresh_token', data.refreshToken, REFRESH_COOKIE_OPTIONS)
    }

    res.status(200).json({
      status: 'success',
      data: {
        user:         data.user,
        expiresAt:    data.accessExpiresAt,
        accessToken:  data.accessToken,
        refreshToken: data.refreshToken,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid or expired code'
    console.error('OTP VERIFICATION ERROR:', err)
    res.status(401).json({ status: 'error', message })
  }
}

export async function loginWithPassword(req: Request, res: Response) {
  try {
    const userAgent = req.headers['user-agent']
    const data = await AuthService.loginWithPassword(req.body, userAgent)

    const isMobile = req.body.platform === 'mobile'
    if (!isMobile) {
      res.cookie('access_token',  data.accessToken,  ACCESS_COOKIE_OPTIONS)
      res.cookie('refresh_token', data.refreshToken, REFRESH_COOKIE_OPTIONS)
    }

    res.status(200).json({
      status: 'success',
      data: {
        user:         data.user,
        expiresAt:    data.accessExpiresAt,
        accessToken:  data.accessToken,
        refreshToken: data.refreshToken,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid credentials'
    console.error('PASSWORD LOGIN ERROR FULL:', err)
    res.status(401).json({ status: 'error', message })
  }
}

export async function refreshToken(req: Request, res: Response) {
  try {
    const token = req.cookies.refresh_token ?? req.body.refreshToken
    if (!token) {
      res.status(401).json({ status: 'error', message: 'No refresh token provided' })
      return
    }

    const data = await AuthService.refreshAccessToken(token)

    const isMobile = !!req.body.refreshToken && !req.cookies.refresh_token
    if (!isMobile) {
      res.cookie('access_token', data.accessToken, ACCESS_COOKIE_OPTIONS)
    }

    res.status(200).json({
      status: 'success',
      data: {
        expiresAt:   data.accessExpiresAt,
        accessToken: data.accessToken,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Session expired. Please log in again.'
    console.error('TOKEN REFRESH ERROR:', err)
    clearAuthCookies(res)
    res.status(401).json({ status: 'error', message })
  }
}

export async function logout(req: Request, res: Response) {
  try {
    const cookieToken = req.cookies.access_token
    const bearerToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null
    const token = cookieToken ?? bearerToken

    if (token) {
      const tokenHash = hashToken(token)
      await AuthService.logout(tokenHash)
    }

    clearAuthCookies(res)
    res.status(200).json({ status: 'success', message: 'Logged out successfully' })
  } catch (err: unknown) {
    console.error('LOGOUT ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Logout failed' })
  }
}

export async function logoutAll(req: Request, res: Response) {
  try {
    if (!req.user) {
      res.status(401).json({ status: 'error', message: 'Not authenticated' })
      return
    }
    await AuthService.logoutAll(req.user.sub)
    clearAuthCookies(res)
    res.status(200).json({ status: 'success', message: 'Logged out from all devices' })
  } catch (err: unknown) {
    console.error('LOGOUT ALL ERROR:', err)
    res.status(500).json({ status: 'error', message: 'Failed to logout from all devices' })
  }
}

export async function me(req: Request, res: Response) {
  try {
    const userId = req.user?.sub
    if (!userId) {
      res.status(401).json({ status: 'error', message: 'Unauthorized' })
      return
    }
    const user = await AuthService.getMe(userId)
    res.status(200).json({ status: 'success', data: user })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('ME ERROR:', err)
    res.status(500).json({ status: 'error', message })
  }
}



export async function changePassword(req: Request, res: Response) {
  try {
    const userId   = req.user!.sub
    const { password } = req.body

    if (!password || typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ status: 'error', message: 'Password must be at least 8 characters.' })
      return
    }

    await AuthService.changePassword(userId, password)
    res.status(200).json({ status: 'success', message: 'Password updated successfully.' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update password'
    console.error('CHANGE PASSWORD ERROR:', err)
    res.status(500).json({ status: 'error', message })
  }
}