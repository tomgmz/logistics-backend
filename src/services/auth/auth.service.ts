import crypto from 'crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { SignOptions } from 'jsonwebtoken'
import * as AuthModel from '../../models/auth/auth.model.js'
import { sendOtpEmail } from '../../lib/brevo-mailer.js'
import { supabase, supabaseAnon } from '../../lib/supabase.js'
import {
  RequestOtpInput,
  VerifyOtpInput,
  AuthResponse,
  AuthStatusResponse,
  UserRole,
  Platform,
} from '../../types/auth.types.js'

const JWT_SECRET         = process.env.JWT_SECRET!
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET!
const TOKEN_PEPPER       = process.env.TOKEN_PEPPER

const JWT_EXPIRES_IN      = (process.env.JWT_EXPIRES_IN     ?? '15m') as SignOptions['expiresIn']
const JWT_REFRESH_EXPIRES = (process.env.JWT_REFRESH_EXPIRES ?? '7d') as SignOptions['expiresIn']

const OTP_RATE_LIMIT    = 5
const OTP_WINDOW_MINS   = 15
const MAX_OTP_ATTEMPTS  = 3
const MAX_LOCKUPS       = 3
const OTP_EXPIRY_MINS   = 5
const BCRYPT_ROUNDS     = 12
const ACCOUNT_LOCK_MINS = 3

const PLATFORM_RESTRICTIONS: Record<UserRole, Platform[]> = {
  super_admin:      ['web'],
  driver:           ['mobile'],
  general_manager:  ['web'],
  accountant:       ['web'],
  human_resources:  ['web'],
  fleet_admin:      ['web'],
  operations_admin: ['web'],
  it_admin:         ['web'],
  client:           ['web'],
  vendor:           ['web'],
}

function isRoleAllowedOnPlatform(role: string, platform: Platform): boolean {
  const allowedPlatforms = PLATFORM_RESTRICTIONS[role as UserRole] ?? []
  return allowedPlatforms.includes(platform)
}

const ROLE_PORTAL: Record<UserRole, string> = {
  super_admin:      '/portal/admin',
  general_manager:  '/portal/operations',
  accountant:       '/portal/finance',
  human_resources:  '/portal/hr',
  fleet_admin:      '/portal/fleet',
  operations_admin: '/portal/operations',
  it_admin:         '/portal/admin',
  driver:           'mobile://navigation',
  client:           '/portal/client',
  vendor:           '/portal/vendor',
}

function generateOtp(): string {
  const buf = crypto.randomBytes(4)
  const num = buf.readUInt32BE(0) % 1_000_000
  return num.toString().padStart(6, '0')
}

export function hashToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token + TOKEN_PEPPER)
    .digest('hex')
}

async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, BCRYPT_ROUNDS)
}

async function verifyOtpHash(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash)
}

function generateDeviceFingerprint(userAgent: string, ip: string): string {
  return crypto
    .createHash('sha256')
    .update(`${userAgent}:${ip}`)
    .digest('hex')
    .slice(0, 32)
}

function buildAuthResponse(
  user: { user_id: string; email: string; first_name: string | null; last_name: string | null; role: UserRole; status: string },
  accessToken: string,
  refreshToken: string,
  accessExpiresAt: Date,
  refreshExpiresAt: Date,
): AuthResponse {
  return {
    accessToken,
    refreshToken,
    accessExpiresAt:  accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
    user: {
      user_id:    user.user_id,
      email:      user.email,
      first_name: user.first_name,
      last_name:  user.last_name,
      role:       user.role,
      status:     user.status,
    },
    portalUrl: ROLE_PORTAL[user.role as UserRole] ?? '/portal',
  }
}

async function createTokensAndSession(
  user: { user_id: string; role: UserRole; email: string },
  ipAddress?: string,
  deviceInfo?: string,
): Promise<{ accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date }> {
  const accessExpiresAt  = new Date(Date.now() + parseDuration(JWT_EXPIRES_IN as string))
  const refreshExpiresAt = new Date(Date.now() + parseDuration(JWT_REFRESH_EXPIRES as string))

  const accessToken = jwt.sign(
    { sub: user.user_id, role: user.role, email: user.email, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )

  const refreshToken = jwt.sign(
    { sub: user.user_id, role: user.role, type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES }
  )

  const accessTokenHash  = hashToken(accessToken)
  const refreshTokenHash = hashToken(refreshToken)

  await AuthModel.revokeAllUserSessions(user.user_id)
  await AuthModel.createSession({
    user_id:           user.user_id,
    token:             accessTokenHash,
    refresh_token:     refreshTokenHash,
    expires_at:        accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    ip_address:        ipAddress,
    device_info:       deviceInfo,
  })

  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
}

export async function getAuthStatus(email: string): Promise<AuthStatusResponse> {
  const normalizedEmail = email.trim().toLowerCase()
  const user = await AuthModel.findUserByEmail(normalizedEmail)

  if (!user) {
    return { locked: false }
  }

  if (user.status === 'permanently_locked') {
    return { locked: true, permanent: true, role: user.role }
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return {
      locked:       true,
      locked_until: new Date(user.locked_until).toISOString(),
      role:         user.role,
    }
  }

  return { locked: false, role: user.role }
}

export async function requestOtp(
  input: RequestOtpInput,
  ipAddress?: string
): Promise<void> {
  const email = input.email.trim().toLowerCase()

  const user = await AuthModel.findUserByEmail(email)
  if (!user || user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email,
      ip_address: ipAddress,
      attempt_status: user?.status === 'permanently_locked'
        ? 'failed_permanently_locked'
        : 'failed_inactive',
      failure_reason: !user ? 'User not found' : `Account status: ${user.status}`,
    })
    return
  }

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

  const since = new Date(Date.now() - OTP_WINDOW_MINS * 60 * 1000)
  const recentCount = await AuthModel.getOtpAttemptsSince(user.user_id, since)
  if (recentCount >= OTP_RATE_LIMIT) return

  const plainOtp  = generateOtp()
  const hashedOtp = await hashOtp(plainOtp)
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINS * 60 * 1000)

  await AuthModel.createOtp(user.user_id, email, hashedOtp, ipAddress, expiresAt)
  await sendOtpEmail(email, plainOtp, user.first_name)
}

export async function verifyOtp(
  input: VerifyOtpInput,
  ipAddress?: string,
  userAgent?: string
): Promise<AuthResponse> {
  const email     = input.email.trim().toLowerCase()
  const cleanCode = input.code.trim().slice(0, 6)

  const user = await AuthModel.findUserByEmail(email)

  if (!user) {
    await AuthModel.createLoginHistory({
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_inactive',
      failure_reason: 'User not found',
    })
    throw new Error('Invalid credentials')
  }

  if (user.status === 'permanently_locked') {
    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_permanently_locked',
      failure_reason: 'Account permanently locked',
    })
    throw new Error('Account permanently locked. Please contact an administrator.')
  }

  if (user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_inactive',
      failure_reason: `Account status: ${user.status}`,
    })
    throw new Error('Invalid credentials')
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000)
    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      ip_address: ipAddress,
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked for ${minutesLeft} more minutes`,
    })
    throw new Error(`Account temporarily locked. Please try again in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.`)
  }

  const currentFailedAttempts = user.failed_login_attempts ?? 0
  if (currentFailedAttempts >= MAX_OTP_ATTEMPTS) {
    await AuthModel.markOtpUsed((await AuthModel.findLatestOtp(user.user_id))?.id ?? '')
    const newLockupCount = await AuthModel.incrementLockupCount(user.user_id)

    if (newLockupCount >= MAX_LOCKUPS) {
      await AuthModel.permanentlyLockUser(user.user_id)
      await AuthModel.createLoginHistory({
        user_id: user.user_id, email, ip_address: ipAddress,
        device_info: input.device_info, user_agent: userAgent,
        attempt_status: 'failed_permanently_locked',
        failure_reason: `Account permanently locked after ${MAX_LOCKUPS} lockout cycles`,
      })
      throw new Error('Account permanently locked. Please contact an administrator.')
    }

    const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
    await AuthModel.lockUserAccount(user.user_id, lockUntil)
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked (${newLockupCount}/${MAX_LOCKUPS}) after ${MAX_OTP_ATTEMPTS} failed attempts`,
    })
    throw new Error('Account temporarily locked. Too many failed attempts.')
  }

  const latestOtp = await AuthModel.findLatestOtp(user.user_id)
  if (!latestOtp) {
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_otp',
      failure_reason: 'No valid OTP found',
    })
    throw new Error('Invalid or expired code')
  }

  const isValidOtp = await verifyOtpHash(cleanCode, latestOtp.code_hash!)

  if (!isValidOtp) {
    await AuthModel.incrementOtpAttempts(latestOtp.id)
    const newFailedCount = await AuthModel.incrementFailedLoginAttempts(user.user_id)
    const remainingAttempts = MAX_OTP_ATTEMPTS - newFailedCount

    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_otp',
      failure_reason: `Wrong OTP (${remainingAttempts} attempts left)`,
    })

    if (remainingAttempts > 0) {
      throw new Error(`Invalid code. ${remainingAttempts} attempt${remainingAttempts > 1 ? 's' : ''} remaining.`)
    }

    const newLockupCount = await AuthModel.incrementLockupCount(user.user_id)
    await AuthModel.markOtpUsed(latestOtp.id)

    if (newLockupCount >= MAX_LOCKUPS) {
      await AuthModel.permanentlyLockUser(user.user_id)
      await AuthModel.createLoginHistory({
        user_id: user.user_id, email, ip_address: ipAddress,
        device_info: input.device_info, user_agent: userAgent,
        attempt_status: 'failed_permanently_locked',
        failure_reason: `Account permanently locked after ${MAX_LOCKUPS} lockout cycles`,
      })
      throw new Error('Account permanently locked. Please contact an administrator.')
    }

    const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
    await AuthModel.lockUserAccount(user.user_id, lockUntil)
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked (${newLockupCount}/${MAX_LOCKUPS})`,
    })
    throw new Error(`Account locked due to too many failed attempts. (${newLockupCount}/${MAX_LOCKUPS} lockouts used)`)
  }

  await AuthModel.markOtpUsed(latestOtp.id)
  await AuthModel.resetFailedAttempts(user.user_id)

  const requestedPlatform = (input.platform ?? 'web') as Platform
  if (!isRoleAllowedOnPlatform(user.role, requestedPlatform)) {
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_inactive',
      failure_reason: `Role '${user.role}' is not permitted on platform '${requestedPlatform}'`,
    })
    throw new Error(
      requestedPlatform === 'mobile'
        ? 'Mobile access is not available for your account type.'
        : 'Web access is not available for your account type.'
    )
  }

  const deviceFingerprint = userAgent
    ? generateDeviceFingerprint(userAgent, ipAddress || 'unknown')
    : undefined

  if (deviceFingerprint) {
    const riskAssessment = await AuthModel.detectSuspiciousLogin(user.user_id, ipAddress, deviceFingerprint)
    if (riskAssessment.requires_additional_verification) {
      console.warn(`High-risk login detected for user ${user.user_id}:`, riskAssessment)
    }
    await AuthModel.upsertTrustedDevice({
      user_id:            user.user_id,
      device_fingerprint: deviceFingerprint,
      device_name:        input.device_info || 'Unknown Device',
      trust_score:        Math.max(0, 100 - riskAssessment.risk_score),
      is_trusted:         riskAssessment.risk_score < 30,
    })
  }

  const { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt } =
    await createTokensAndSession(user, ipAddress, input.device_info)

  await AuthModel.updateLastLogin(user.user_id, ipAddress)
  await AuthModel.createLoginHistory({
    user_id: user.user_id, email, ip_address: ipAddress,
    device_info: input.device_info, user_agent: userAgent,
    attempt_status: 'success',
  })

  return buildAuthResponse(user, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt)
}

export async function loginWithPassword(
  input: { email: string; password: string; device_info?: string; platform?: string },
  ipAddress?: string,
  userAgent?: string,
): Promise<AuthResponse> {
  const email = input.email.trim().toLowerCase()

  const user = await AuthModel.findUserByEmail(email)

  if (!user) {
    throw new Error('Invalid credentials')
  }

  if (user.status === 'permanently_locked') {
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_permanently_locked',
      failure_reason: 'Account permanently locked',
    })
    throw new Error('Account permanently locked. Please contact an administrator.')
  }

  if (user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_inactive',
      failure_reason: `Account status: ${user.status}`,
    })
    throw new Error('Invalid credentials')
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000)
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked for ${minutesLeft} more minutes`,
    })
    throw new Error(`Account temporarily locked. Please try again in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.`)
  }

  const { error: authError } = await supabaseAnon.auth.signInWithPassword({
    email,
    password: input.password,
  })

  if (authError) {
    const newFailedCount    = await AuthModel.incrementFailedLoginAttempts(user.user_id)
    const remainingAttempts = MAX_OTP_ATTEMPTS - newFailedCount

    await AuthModel.createLoginHistory({
      user_id: user.user_id, email, ip_address: ipAddress,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_otp', // reusing closest status
      failure_reason: `Wrong password (${remainingAttempts} attempts left)`,
    })

    if (remainingAttempts > 0) {
      throw new Error(`Incorrect password. ${remainingAttempts} attempt${remainingAttempts > 1 ? 's' : ''} remaining.`)
    }

    const newLockupCount = await AuthModel.incrementLockupCount(user.user_id)

    if (newLockupCount >= MAX_LOCKUPS) {
      await AuthModel.permanentlyLockUser(user.user_id)
      await AuthModel.createLoginHistory({
        user_id: user.user_id, email, ip_address: ipAddress,
        device_info: input.device_info, user_agent: userAgent,
        attempt_status: 'failed_permanently_locked',
        failure_reason: `Account permanently locked after ${MAX_LOCKUPS} lockout cycles`,
      })
      throw new Error('Account permanently locked. Please contact an administrator.')
    }

    const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
    await AuthModel.lockUserAccount(user.user_id, lockUntil)
    throw new Error(`Account locked due to too many failed attempts. (${newLockupCount}/${MAX_LOCKUPS} lockouts used)`)
  }

  await AuthModel.resetFailedAttempts(user.user_id)

  const requestedPlatform = (input.platform ?? 'web') as Platform
  if (!isRoleAllowedOnPlatform(user.role, requestedPlatform)) {
    throw new Error(
      requestedPlatform === 'mobile'
        ? 'Mobile access is not available for your account type.'
        : 'Web access is not available for your account type.'
    )
  }

  const { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt } =
    await createTokensAndSession(user, ipAddress, input.device_info)

  await AuthModel.updateLastLogin(user.user_id, ipAddress)
  await AuthModel.createLoginHistory({
    user_id: user.user_id, email, ip_address: ipAddress,
    device_info: input.device_info, user_agent: userAgent,
    attempt_status: 'success',
  })

  return buildAuthResponse(user, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt)
}

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

  if (payload.type !== 'refresh') throw new Error('Invalid token type')

  const refreshTokenHash = hashToken(refreshToken)
  const session = await AuthModel.findActiveSessionByRefreshToken(refreshTokenHash)
  if (!session) throw new Error('Session expired or revoked')

  const user = await AuthModel.findUserById(payload.sub)
  if (!user || user.status !== 'active') throw new Error('User not found or inactive')

  const accessExpiresAt = new Date(Date.now() + parseDuration(JWT_EXPIRES_IN as string))
  const accessToken = jwt.sign(
    { sub: user.user_id, role: user.role, email: user.email, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )

  const accessTokenHash = hashToken(accessToken)
  await AuthModel.updateSessionAccessToken(session.id, accessTokenHash, accessExpiresAt)
  await AuthModel.refreshSessionLastSeen(session.id)

  return { accessToken, accessExpiresAt: accessExpiresAt.toISOString() }
}

export async function logout(tokenHash: string): Promise<void> {
  await AuthModel.revokeSession(tokenHash)
}

export async function logoutAll(userId: string): Promise<void> {
  await AuthModel.revokeAllUserSessions(userId)
}

export async function getMe(userId: string) {
  const user = await AuthModel.findUserById(userId)
  if (!user) throw new Error('User not found')

  switch (user.role) {
    case 'driver': {
      const data = await AuthModel.findUserWithDriver(userId)
      if (!data) throw new Error('User not found')
      return { ...data, driver_id: data.drivers?.driver_id ?? null }
    }
    case 'client':
      return AuthModel.findUserWithClient(userId)
    default:
      return user
  }
}

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