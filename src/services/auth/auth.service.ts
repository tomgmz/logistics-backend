import crypto from 'crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { SignOptions } from 'jsonwebtoken'
import * as AuthModel from '../../models/auth/auth.model.js'
import { sendOtpEmail } from '../../lib/mailer-sendgrid.js'
import { RequestOtpInput, VerifyOtpInput, AuthResponse } from '../../types/auth.types.js'

const JWT_SECRET          = process.env.JWT_SECRET!
const JWT_REFRESH_SECRET  = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET!
const TOKEN_PEPPER        = process.env.TOKEN_PEPPER || 'CHANGE_ME_IN_PRODUCTION'

const JWT_EXPIRES_IN      = (process.env.JWT_EXPIRES_IN    ?? '15m') as SignOptions['expiresIn']
const JWT_REFRESH_EXPIRES = (process.env.JWT_REFRESH_EXPIRES ?? '7d') as SignOptions['expiresIn']

const OTP_RATE_LIMIT    = 5    // max OTP requests per window
const OTP_WINDOW_MINS   = 15   // rate-limit window
const MAX_OTP_ATTEMPTS  = 5    // max wrong guesses
const OTP_EXPIRY_MINS   = 5    // OTP validity
const BCRYPT_ROUNDS     = 12   // OTP hash strength
const ACCOUNT_LOCK_MINS = 30   // lockout duration after max failed attempts


//GENERATE OTP
function generateOtp(): string {
  const buf = crypto.randomBytes(4)
  const num = buf.readUInt32BE(0) % 1_000_000
  return num.toString().padStart(6, '0')
}

//HASH TOKEN WITH PEPPER
export function hashToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token + TOKEN_PEPPER)
    .digest('hex')
}

//HASH OTP
async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, BCRYPT_ROUNDS)
}

async function verifyOtpHash(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash)
}

//GENERATE DEVICE FINGERPRINT
function generateDeviceFingerprint(userAgent: string, ip: string): string {
  return crypto
    .createHash('sha256')
    .update(`${userAgent}:${ip}`)
    .digest('hex')
    .slice(0, 32)
}

//REQUEST OTP

export async function requestOtp(
  input: RequestOtpInput,
  ipAddress?: string
): Promise<void> {
  const email = input.email.trim().toLowerCase()

  // Find user (silent fail if not found for security)
  const user = await AuthModel.findUserByEmail(email)
  if (!user || user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email,
      ip_address: ipAddress,
      attempt_status: 'failed_inactive',
      failure_reason: user ? 'Account not active' : 'User not found',
    })
    return
  }

  // Check if account is locked
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      ip_address: ipAddress,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked until ${user.locked_until}`,
    })
    return 
  }

  // Rate limiting
  const since = new Date(Date.now() - OTP_WINDOW_MINS * 60 * 1000)
  const recentCount = await AuthModel.getOtpAttemptsSince(user.user_id, since)
  if (recentCount >= OTP_RATE_LIMIT) {
    return
  }

  // Generate and hash OTP
  const plainOtp = generateOtp()
  const hashedOtp = await hashOtp(plainOtp)

  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINS * 60 * 1000)

  // Store HASHED OTP with expiry
  await AuthModel.createOtp(
    user.user_id,
    email,
    hashedOtp,
    ipAddress,
    expiresAt
  )

  // Send plain OTP via email (this is the only place it exists in plain text)
  await sendOtpEmail(email, plainOtp, user.first_name)
}

//VERIFY OTP AND ISSUE TOKEN

export async function verifyOtp(
  input: VerifyOtpInput,
  ipAddress?: string,
  userAgent?: string
): Promise<AuthResponse> {
  const email = input.email.trim().toLowerCase()
  const cleanCode = input.code.trim().slice(0, 6)

  // Find user
  const user = await AuthModel.findUserByEmail(email)
  if (!user || user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_inactive',
      failure_reason: 'User not found or inactive',
    })
    throw new Error('Invalid credentials')
  }

  // Check account lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil(
      (new Date(user.locked_until).getTime() - Date.now()) / 60000
    )
    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked for ${minutesLeft} more minutes`,
    })
    throw new Error('Account temporarily locked. Please try again later.')
  }

  // Find latest valid OTP
  const latestOtp = await AuthModel.findLatestOtp(user.user_id)
  if (!latestOtp) {
    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_otp',
      failure_reason: 'No valid OTP found',
    })
    throw new Error('Invalid or expired code')
  }

  // Check if OTP is blocked (too many attempts)
  if (latestOtp.attempts >= MAX_OTP_ATTEMPTS) {
    await AuthModel.markOtpUsed(latestOtp.id)

    const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
    await AuthModel.lockUserAccount(user.user_id, lockUntil)

    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked due to ${MAX_OTP_ATTEMPTS} failed attempts`,
    })

    throw new Error('Too many failed attempts. Account locked temporarily.')
  }

  const isValidOtp = await verifyOtpHash(cleanCode, latestOtp.code_hash!)

  if (!isValidOtp) {
    await AuthModel.incrementOtpAttempts(latestOtp.id)

    const remainingAttempts = MAX_OTP_ATTEMPTS - (latestOtp.attempts + 1)

    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_otp',
      failure_reason: `Wrong OTP (${remainingAttempts} attempts left)`,
    })

    if (remainingAttempts > 0) {
      throw new Error(`Invalid code. ${remainingAttempts} attempt${remainingAttempts > 1 ? 's' : ''} remaining.`)
    } else {
      const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
      await AuthModel.lockUserAccount(user.user_id, lockUntil)
      await AuthModel.markOtpUsed(latestOtp.id)
      throw new Error('Account locked due to too many failed attempts.')
    }
  }

  //OTP VERIFIED - Proceed with login

  await AuthModel.markOtpUsed(latestOtp.id)
  await AuthModel.resetFailedAttempts(user.user_id)

  // Check for suspicious activity
  const deviceFingerprint = userAgent
    ? generateDeviceFingerprint(userAgent, ipAddress || 'unknown')
    : undefined

  if (deviceFingerprint) {
    const riskAssessment = await AuthModel.detectSuspiciousLogin(
      user.user_id,
      ipAddress,
      deviceFingerprint
    )

    if (riskAssessment.requires_additional_verification) {
      console.warn(`High-risk login detected for user ${user.user_id}:`, riskAssessment)
    }

    await AuthModel.upsertTrustedDevice({
      user_id: user.user_id,
      device_fingerprint: deviceFingerprint,
      device_name: input.device_info || 'Unknown Device',
      trust_score: Math.max(0, 100 - riskAssessment.risk_score),
      is_trusted: riskAssessment.risk_score < 30,
    })
  }

  // Revoke ALL existing sessions (force re-login on all devices)
  await AuthModel.revokeAllUserSessions(user.user_id)

  // Generate access and refresh tokens
  const accessExpiresAt  = new Date(Date.now() + parseDuration(JWT_EXPIRES_IN as string))
  const refreshExpiresAt = new Date(Date.now() + parseDuration(JWT_REFRESH_EXPIRES as string))

  const accessToken = jwt.sign(
    {
      sub: user.user_id,
      role: user.role,
      email: user.email,
      type: 'access',
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )

  const refreshToken = jwt.sign(
    {
      sub: user.user_id,
      role: user.role,
      type: 'refresh',
    },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES }
  )

  // Hash tokens with PEPPER before storage
  const accessTokenHash  = hashToken(accessToken)
  const refreshTokenHash = hashToken(refreshToken)

  await AuthModel.createSession({
    user_id: user.user_id,
    token: accessTokenHash,
    refresh_token: refreshTokenHash,
    expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    ip_address: ipAddress,
    device_info: input.device_info,
  })

  await AuthModel.updateLastLogin(user.user_id, ipAddress)

  await AuthModel.createLoginHistory({
    user_id: user.user_id,
    email,
    ip_address: ipAddress,
    device_info: input.device_info,
    user_agent: userAgent,
    attempt_status: 'success',
  })

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
    user: {
      user_id: user.user_id,
      email: user.email,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      status: user.status,
    },
  }
}

//REFRESH TOKEN

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string
  accessExpiresAt: string
}> {
  let payload: any
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET)
  } catch {
    throw new Error('Invalid or expired refresh token')
  }

  if (payload.type !== 'refresh') {
    throw new Error('Invalid token type')
  }

  const refreshTokenHash = hashToken(refreshToken)
  const session = await AuthModel.findActiveSessionByRefreshToken(refreshTokenHash)

  if (!session) {
    throw new Error('Session expired or revoked')
  }

  const user = await AuthModel.findUserById(payload.sub)
  if (!user || user.status !== 'active') {
    throw new Error('User not found or inactive')
  }

  const accessExpiresAt = new Date(Date.now() + parseDuration(JWT_EXPIRES_IN as string))

  const accessToken = jwt.sign(
    {
      sub: user.user_id,
      role: user.role,
      email: user.email,
      type: 'access',
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )

  const accessTokenHash = hashToken(accessToken)
  await AuthModel.updateSessionAccessToken(session.id, accessTokenHash, accessExpiresAt)
  await AuthModel.refreshSessionLastSeen(session.id)

  return {
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
  }
}

//LOGOUT

export async function logout(tokenHash: string): Promise<void> {
  await AuthModel.revokeSession(tokenHash)
}

export async function logoutAll(userId: string): Promise<void> {
  await AuthModel.revokeAllUserSessions(userId)
}

//HELPERS

function parseDuration(d: string): number {
  const match = d.match(/^(\d+)([smhd])$/)
  if (!match) return 15 * 60 * 1000
  const value = parseInt(match[1])
  switch (match[2]) {
    case 's': return value * 1000
    case 'm': return value * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'd': return value * 24 * 60 * 60 * 1000
    default:  return 15 * 60 * 1000
  }
}

export async function getMe(userId: string) {
  const user = await AuthModel.findUserWithClient(userId)
  if (!user) throw new Error('User not found')
  return user
}