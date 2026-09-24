import crypto from 'crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { SignOptions } from 'jsonwebtoken'
import * as AuthModel from '../../models/auth/auth.model.js'
import { sendOtpEmail } from '../../lib/brevo-mailer.js'
import { supabase, supabaseAnon } from '../../lib/supabase.js'
import { isManagedRole } from '../../constants/modules.js'
import { getSessionPermissions } from '../admin/permissions.service.js'
import { isProtectedAdmin } from '../../lib/protected-admin.js'
import { logEvent } from '../../lib/log-event.js'
import { logSystem } from '../../lib/log-system.js'
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

const OTP_RATE_LIMIT    = 10
const OTP_WINDOW_MINS   = 15
const OTP_COOLDOWN_SECS = 60
const MAX_OTP_ATTEMPTS  = 3
const MAX_LOCKUPS       = 3
const OTP_EXPIRY_MINS   = 5
const BCRYPT_ROUNDS     = 12
const ACCOUNT_LOCK_MINS = 3

const PLATFORM_RESTRICTIONS: Record<UserRole, Platform[]> = {
  admin:            ['web'],
  driver:           ['mobile'],
  general_manager:  ['web'],
  fleet_manager:      ['web'],
  operations_manager: ['web'],
  it_admin:         ['web'],
  client:           ['web'],
}

function isRoleAllowedOnPlatform(role: string, platform: Platform): boolean {
  const allowedPlatforms = PLATFORM_RESTRICTIONS[role as UserRole] ?? []
  return allowedPlatforms.includes(platform)
}

const ROLE_PORTAL: Record<UserRole, string> = {
  admin:            '/portal/admin',
  general_manager:  '/portal/general_manager',
  fleet_manager:      '/portal/fleet_admin',
  operations_manager: '/portal/operations_admin',
  it_admin:         '/portal/it_admin',
  driver:           'mobile://navigation',
  client:           '/portal/client',
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

function generateDeviceFingerprint(userAgent: string): string {
  return crypto
    .createHash('sha256')
    .update(userAgent)
    .digest('hex')
    .slice(0, 32)
}

function buildAuthResponse(
  user: { user_id: string; email: string; first_name: string | null; last_name: string | null; role: UserRole; status: string; must_change_password?: boolean },
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
      user_id:              user.user_id,
      email:                user.email,
      first_name:           user.first_name,
      last_name:            user.last_name,
      role:                 user.role,
      status:               user.status,
      must_change_password: user.must_change_password ?? false,
    },
    portalUrl: ROLE_PORTAL[user.role as UserRole] ?? '/portal',
  }
}

export async function changePassword(
  userId:      string,
  newPassword: string,
): Promise<void> {
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword,
  })
  if (error) throw new Error(`Failed to update password: ${error.message}`)
  await AuthModel.clearMustChangePassword(userId)

  logEvent({
    user_id:  userId,
    log_type: 'auth',
    action:   'password_changed',
    // No password material, obviously — only that it happened and to whom.
    description: 'Account password changed',
  })
}

async function createTokensAndSession(
  user: { user_id: string; role: UserRole; email: string },
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
    user_id:            user.user_id,
    token:              accessTokenHash,
    refresh_token:      refreshTokenHash,
    expires_at:         accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    device_info:        deviceInfo,
  })

  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
}

/**
 * Mint a session for a user who has already been authenticated by some other
 * means, and shape it into the response every login path returns.
 *
 * This exists so the passkey flow does not grow its own copy of the token
 * logic. createTokensAndSession is where the single-active-session invariant
 * lives (it revokes every prior session before creating one), where token
 * hashing with the pepper happens, and where active_sessions rows come from.
 * A second implementation would drift from all three silently.
 *
 * The caller is responsible for having actually verified the user. Nothing here
 * checks a credential.
 */
export async function issueVerifiedSession(
  user: {
    user_id: string
    email: string
    first_name: string | null
    last_name: string | null
    role: UserRole
    status: string
    must_change_password?: boolean
  },
  deviceInfo?: string,
): Promise<AuthResponse> {
  const tokens = await createTokensAndSession(user, deviceInfo)
  return buildAuthResponse(
    user,
    tokens.accessToken,
    tokens.refreshToken,
    tokens.accessExpiresAt,
    tokens.refreshExpiresAt,
  )
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
  input: RequestOtpInput
): Promise<void> {
  const email = input.email.trim().toLowerCase()

  const user = await AuthModel.findUserByEmail(email)
  if (!user || user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email,
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
      attempt_status: 'failed_locked',
      failure_reason: `Account locked until ${user.locked_until}`,
    })
    return
  }

  const latestOtp = await AuthModel.findLatestOtp(user.user_id)
  if (latestOtp) {
    const secondsSinceLast = (Date.now() - new Date(latestOtp.created_at).getTime()) / 1000
    if (secondsSinceLast < OTP_COOLDOWN_SECS) {
      const retryAfter = Math.ceil(OTP_COOLDOWN_SECS - secondsSinceLast)
      const err = new Error(`Please wait ${retryAfter} second${retryAfter !== 1 ? 's' : ''} before requesting another code.`)
      ;(err as any).code       = 'OTP_COOLDOWN'
      ;(err as any).retryAfter = retryAfter
      throw err
    }
  }

  const since = new Date(Date.now() - OTP_WINDOW_MINS * 60 * 1000)
  const recentCount = await AuthModel.getOtpAttemptsSince(user.user_id, since)
  if (recentCount >= OTP_RATE_LIMIT) {
    console.warn(`OTP_RATE_LIMIT exceeded for user ${user.user_id}`)
    return
  }

  const plainOtp  = generateOtp()
  const hashedOtp = await hashOtp(plainOtp)
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINS * 60 * 1000)

  await AuthModel.createOtp(user.user_id, email, hashedOtp, expiresAt)

  try {
    await sendOtpEmail(email, plainOtp, user.first_name)
    console.log(`OTP sent successfully to ${email} for user ${user.user_id}`)
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`OTP_EMAIL_SEND_FAILED for user ${user.user_id}:`, errorMsg)
    throw err
  }
}

export async function verifyOtp(
  input: VerifyOtpInput,
  userAgent?: string
): Promise<AuthResponse> {
  const email     = input.email.trim().toLowerCase()
  const cleanCode = input.code.trim().slice(0, 6)

  const user = await AuthModel.findUserByEmail(email)

  if (!user) {
    await AuthModel.createLoginHistory({
      email,
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
      device_info: input.device_info,
      user_agent: userAgent,
      attempt_status: 'failed_permanently_locked',
      failure_reason: 'Account permanently locked',
    })
    throw new Error('Account permanently locked. Request a password reset to regain access.')
  }

  if (user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email,
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
        user_id: user.user_id, email,
        device_info: input.device_info, user_agent: userAgent,
        attempt_status: 'failed_permanently_locked',
        failure_reason: `Account permanently locked after ${MAX_LOCKUPS} lockout cycles`,
      })
      throw new Error('Account permanently locked. Request a password reset to regain access.')
    }

    const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
    await AuthModel.lockUserAccount(user.user_id, lockUntil)
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked (${newLockupCount}/${MAX_LOCKUPS}) after ${MAX_OTP_ATTEMPTS} failed attempts`,
    })
    throw new Error('Account temporarily locked. Too many failed attempts.')
  }

  const latestOtp = await AuthModel.findLatestOtp(user.user_id)
  if (!latestOtp) {
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email,
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
      user_id: user.user_id, email,
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
        user_id: user.user_id, email,
        device_info: input.device_info, user_agent: userAgent,
        attempt_status: 'failed_permanently_locked',
        failure_reason: `Account permanently locked after ${MAX_LOCKUPS} lockout cycles`,
      })
      throw new Error('Account permanently locked. Request a password reset to regain access.')
    }

    const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
    await AuthModel.lockUserAccount(user.user_id, lockUntil)
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email,
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
      user_id: user.user_id, email,
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
    ? generateDeviceFingerprint(userAgent)
    : undefined

  if (deviceFingerprint) {
    const riskAssessment = await AuthModel.detectSuspiciousLogin(user.user_id, deviceFingerprint)
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
    await createTokensAndSession(user, input.device_info)

  await AuthModel.updateLastLogin(user.user_id)
  await AuthModel.createLoginHistory({
    user_id: user.user_id, email,
    device_info: input.device_info, user_agent: userAgent,
    attempt_status: 'success',
  })

  // login_history above is the detailed record, but nothing surfaces it in
  // either log UI — and passkey sign-ins were already writing to the audit
  // trail, so password sign-ins were the only ones invisible there.
  logEvent({
    user_id:     user.user_id,
    log_type:    'auth',
    action:      'login_succeeded',
    description: `Password sign-in for ${email} (${requestedPlatform})`,
  })

  return buildAuthResponse(user, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt)
}

export async function loginWithPassword(
  input: { email: string; password: string; device_info?: string; platform?: string },
  userAgent?: string,
): Promise<AuthResponse> {
  const email = input.email.trim().toLowerCase()

  const user = await AuthModel.findUserByEmail(email)

  if (!user) {
    throw new Error('Invalid credentials')
  }

  if (user.status === 'permanently_locked') {
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_permanently_locked',
      failure_reason: 'Account permanently locked',
    })
    throw new Error('Account permanently locked. Request a password reset to regain access.')
  }

  if (user.status !== 'active') {
    await AuthModel.createLoginHistory({
      email,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_inactive',
      failure_reason: `Account status: ${user.status}`,
    })
    throw new Error('Invalid credentials')
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000)
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_locked',
      failure_reason: `Account locked for ${minutesLeft} more minutes`,
    })
    throw new Error(`Account temporarily locked. Please try again in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.`)
  }

  // An outside-vendor driver has a password in auth.users only because Supabase
  // requires one; it is random, was never shown to anyone, and their way in is
  // the passkey on their phone. Refuse before reaching signInWithPassword so
  // this stays a closed door rather than an unguessable one.
  if (await AuthModel.isExternalDriver(user.user_id)) {
    await AuthModel.createLoginHistory({
      user_id: user.user_id, email,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_inactive',
      failure_reason: 'External driver attempted password login',
    })
    throw new Error('This account signs in with a passkey. Open the app and use "Sign in with a passkey".')
  }

  const { error: authError } = await supabaseAnon.auth.signInWithPassword({
    email,
    password: input.password,
  })

  if (authError) {
    const newFailedCount    = await AuthModel.incrementFailedLoginAttempts(user.user_id)
    const remainingAttempts = MAX_OTP_ATTEMPTS - newFailedCount

    await AuthModel.createLoginHistory({
      user_id: user.user_id, email,
      device_info: input.device_info, user_agent: userAgent,
      attempt_status: 'failed_otp',
      failure_reason: `Wrong password (${remainingAttempts} attempts left)`,
    })

    // Failure diagnostics, not a business record: the Company Admin does not
    // need every fat-fingered password, the IT Admin needs the pattern.
    logSystem({
      log_level:  'warn',
      event_type: 'auth_event',
      source:     'auth.service',
      message:    `Failed password login for ${email}`,
      metadata:   { failed_count: newFailedCount, remaining_attempts: remainingAttempts },
    })

    if (remainingAttempts > 0) {
      throw new Error(`Incorrect password. ${remainingAttempts} attempt${remainingAttempts > 1 ? 's' : ''} remaining.`)
    }

    const newLockupCount = await AuthModel.incrementLockupCount(user.user_id)

    if (newLockupCount >= MAX_LOCKUPS) {
      await AuthModel.permanentlyLockUser(user.user_id)
      await AuthModel.createLoginHistory({
        user_id: user.user_id, email,
        device_info: input.device_info, user_agent: userAgent,
        attempt_status: 'failed_permanently_locked',
        failure_reason: `Account permanently locked after ${MAX_LOCKUPS} lockout cycles`,
      })
      // A lockout is one of the cases that legitimately belongs in BOTH feeds:
      // that the account is now locked is a business fact someone will have to
      // undo; how it got there is diagnostics.
      logEvent({
        user_id:     user.user_id,
        log_type:    'auth',
        action:      'account_permanently_locked',
        description: `${email} permanently locked after ${MAX_LOCKUPS} lockout cycles`,
      })
      logSystem({
        log_level:  'critical',
        event_type: 'auth_event',
        source:     'auth.service',
        message:    `Account permanently locked: ${email}`,
        metadata:   { lockup_count: newLockupCount, max_lockups: MAX_LOCKUPS },
      })
      throw new Error('Account permanently locked. Request a password reset to regain access.')
    }

    const lockUntil = new Date(Date.now() + ACCOUNT_LOCK_MINS * 60 * 1000)
    await AuthModel.lockUserAccount(user.user_id, lockUntil)
    logEvent({
      user_id:     user.user_id,
      log_type:    'auth',
      action:      'account_locked',
      description: `${email} locked until ${lockUntil.toISOString()} (lockout ${newLockupCount}/${MAX_LOCKUPS})`,
    })
    logSystem({
      log_level:  'warn',
      event_type: 'auth_event',
      source:     'auth.service',
      message:    `Account temporarily locked: ${email}`,
      metadata:   { lockup_count: newLockupCount, lock_until: lockUntil.toISOString() },
    })
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
    await createTokensAndSession(user, input.device_info)

  await AuthModel.updateLastLogin(user.user_id)
  await AuthModel.createLoginHistory({
    user_id: user.user_id, email,
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
  if (!session) {
    // A structurally valid refresh token with no live session means it was
    // already rotated or revoked — replay, not a routine expiry.
    logSystem({
      log_level:  'critical',
      event_type: 'auth_event',
      source:     'auth.service',
      message:    'Refresh token presented for a revoked or rotated session',
      metadata:   { subject: payload?.sub ?? null },
    })
    throw new Error('Session expired or revoked')
  }

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
  // user_id comes from the ambient request context — logout runs while the
  // caller is still authenticated.
  logEvent({ log_type: 'auth', action: 'logout', description: 'Session ended' })
}

export async function logoutAll(userId: string): Promise<void> {
  await AuthModel.revokeAllUserSessions(userId)
  logEvent({
    user_id:     userId,
    log_type:    'auth',
    action:      'all_sessions_revoked',
    description: 'All sessions revoked for this account',
  })
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
    default: {
      // Travels with the session so the web app can hide actions reserved for the
      // root administrator — the IT Admin handover being the first of them. The
      // API enforces this independently via the isRootAdmin middleware; this flag
      // only spares the user a button that would 403.
      const is_root_admin = await isProtectedAdmin(userId)

      // Attach per-module permissions so the web app can gate UI for managed
      // staff. The root administrator is never restricted, so leave their
      // session with no permission matrix (full role-default access).
      if (isManagedRole(user.role) && !is_root_admin) {
        const module_permissions = await getSessionPermissions(userId)
        return { ...user, is_root_admin, module_permissions }
      }
      return { ...user, is_root_admin }
    }
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