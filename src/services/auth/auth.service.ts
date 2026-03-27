import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import * as AuthModel from '../../models/auth/auth.model.js'
import { sendOtpEmail } from '../../lib/mailer.js'
import { RequestOtpInput, VerifyOtpInput, AuthResponse } from '../../types/auth.types.js'

const JWT_SECRET       = process.env.JWT_SECRET!
const JWT_EXPIRES_IN   = process.env.JWT_EXPIRES_IN ?? '7d'
const OTP_RATE_LIMIT   = 5    // max OTP requests per window
const OTP_WINDOW_MINS  = 15   // rate-limit window in minutes
const MAX_OTP_ATTEMPTS = 5    // max wrong guesses before OTP is invalidated

function generateOtp(): string {
  const buf = crypto.randomBytes(4)
  const num = buf.readUInt32BE(0) % 1_000_000
  return num.toString().padStart(6, '0')
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

//REQUEST OTP

export async function requestOtp(input: RequestOtpInput): Promise<void> {
  const user = await AuthModel.findUserByEmail(input.email)
  if (!user || user.status !== 'active') return

  const since = new Date(Date.now() - OTP_WINDOW_MINS * 60 * 1000)
  const recentCount = await AuthModel.getOtpAttemptsSince(user.user_id, since)
  if (recentCount >= OTP_RATE_LIMIT) return

  const code = generateOtp()

  await AuthModel.createOtp(user.user_id, user.email, code)

  await sendOtpEmail(user.email, code, user.first_name)
}

//VERIFY AND ISSUE TOKEN

export async function verifyOtp(
  input: VerifyOtpInput,
  ipAddress?: string,
): Promise<AuthResponse> {
  const user = await AuthModel.findUserByEmail(input.email)
  if (!user || user.status !== 'active') throw new Error('Invalid or expired code')

  const cleanCode = input.code.slice(0, 6)

  // Find the latest valid OTP for this user regardless of code so we can track attempts even on wrong guesses
  const latestOtp = await AuthModel.findLatestOtp(user.user_id)
  if (!latestOtp) throw new Error('Invalid or expired code')

  // Block if too many wrong attempts
  if (latestOtp.attempts >= MAX_OTP_ATTEMPTS) {
    await AuthModel.markOtpUsed(latestOtp.id)
    throw new Error('Invalid or expired code')
  }

  if (latestOtp.code !== cleanCode) {
    await AuthModel.incrementOtpAttempts(latestOtp.id)
    throw new Error('Invalid or expired code')
  }

  await AuthModel.markOtpUsed(latestOtp.id)
  await AuthModel.revokeAllUserSessions(user.user_id)

  const expiresAt = new Date(Date.now() + parseDuration(JWT_EXPIRES_IN))
  const token = jwt.sign(
    { sub: user.user_id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN as any },
  )

  // STORE HASH JWT
  const tokenHash = hashToken(token)
  await AuthModel.createSession(user.user_id, tokenHash, expiresAt, ipAddress, input.device_info)

  return {
    token,
    expires: expiresAt.toISOString(),
    user: {
      user_id:    user.user_id,
      email:      user.email,
      username:   user.username,
      first_name: user.first_name,
      last_name:  user.last_name,
      role:       user.role,
      status:     user.status,
    },
  }
}

//LOGOUT

export async function logout(tokenHash: string): Promise<void> {
  await AuthModel.revokeSession(tokenHash)
}

//HELPERS

function parseDuration(d: string): number {
  const match = d.match(/^(\d+)([smhd])$/)
  if (!match) return 7 * 24 * 60 * 60 * 1000
  const value = parseInt(match[1])
  switch (match[2]) {
    case 's': return value * 1000
    case 'm': return value * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'd': return value * 24 * 60 * 60 * 1000
    default:  return 7 * 24 * 60 * 60 * 1000
  }
}