import { supabase } from '../../lib/supabase.js'
import { OtpCode, UserSession, AuthUser } from '../../types/auth.types.js'

//USERS

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, username, first_name, last_name, role, status')
    .eq('email', email)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

//OTP

export async function createOtp(
  userId: string,
  email: string,
  code: string
): Promise<void> {
  await supabase
    .from('otp_codes')
    .update({ used: true })
    .eq('user_id', userId)
    .eq('used', false)

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  const { error } = await supabase
    .from('otp_codes')
    .insert({
      user_id:    userId,
      email,
      code,
      expires_at: expiresAt.toISOString(),
      attempts:   0,
    })

  if (error) throw error
}

export async function findValidOtp(
  userId: string,
  code: string
): Promise<OtpCode | null> {
  const { data, error } = await supabase
    .from('otp_codes')
    .select('*')
    .eq('user_id', userId)
    .eq('code', code)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

export async function findLatestOtp(
  userId: string
): Promise<OtpCode | null> {
  const { data, error } = await supabase
    .from('otp_codes')
    .select('*')
    .eq('user_id', userId)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

export async function incrementOtpAttempts(otpId: string): Promise<number> {
  const { data, error } = await supabase.rpc('increment_otp_attempts', { otp_id: otpId })

  if (error) throw error
  return data as number
}

export async function markOtpUsed(otpId: string): Promise<void> {
  const { error } = await supabase
    .from('otp_codes')
    .update({ used: true })
    .eq('id', otpId)

  if (error) throw error
}

export async function getOtpAttemptsSince(
  userId: string,
  since: Date
): Promise<number> {
  const { count, error } = await supabase
    .from('otp_codes')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since.toISOString())

  if (error) throw error
  return count ?? 0
}

// SESSIONS

export async function revokeAllUserSessions(userId: string): Promise<void> {
  const { error } = await supabase
    .from('active_sessions')
    .update({ expires_at: new Date().toISOString() })
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())

  if (error) throw error
}

export async function createSession(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  ipAddress?: string,
  deviceInfo?: string
): Promise<UserSession> {
  const { data, error } = await supabase
    .from('active_sessions')
    .insert({
      user_id:    userId,
      token:      tokenHash,
      expires_at: expiresAt.toISOString(),
      ip_address: ipAddress ?? null,
      device_info: deviceInfo ?? null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function findActiveSession(
  tokenHash: string 
): Promise<UserSession | null> {
  const { data, error } = await supabase
    .from('active_sessions')
    .select('*')
    .eq('token', tokenHash)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

export async function refreshSessionLastSeen(sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('active_sessions')
    .update({ last_active_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) throw error
}

export async function revokeSession(tokenHash: string): Promise<void> {
  const { error } = await supabase
    .from('active_sessions')
    .update({ expires_at: new Date().toISOString() })
    .eq('token', tokenHash)

  if (error) throw error
}