import { supabase } from '../../lib/supabase.js'
import {
  OtpCode,
  UserSession,
  AuthUser,
  LoginHistory,
  TrustedDevice,
  RiskAssessment
} from '../../types/auth.types.js'

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, username, first_name, last_name, role, status, locked_until, failed_login_attempts, lockup_count')
    .eq('email', email)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

export async function incrementLockupCount(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('increment_lockup_count', { p_user_id: userId })
  if (error) throw error
  return data as number
}

export async function incrementFailedLoginAttempts(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('increment_failed_login_attempts', { p_user_id: userId })
  if (error) throw error
  return data as number
}

export async function permanentlyLockUser(userId: string): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({
      status: 'permanently_locked',
      locked_until: null,
      failed_login_attempts: 0,
    })
    .eq('user_id', userId)

  if (error) throw error
}

export async function findUserById(userId: string): Promise<AuthUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, username, first_name, last_name, role, status')
    .eq('user_id', userId)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

export async function lockUserAccount(userId: string, lockUntil: Date): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({
      locked_until: lockUntil.toISOString(),
      failed_login_attempts: 0
    })
    .eq('user_id', userId)

  if (error) throw error
}

export async function resetFailedAttempts(userId: string): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({
      failed_login_attempts: 0,
      locked_until: null,
      lockup_count: 0,
    })
    .eq('user_id', userId)

  if (error) throw error
}

export async function updateLastLogin(userId: string, ipAddress?: string): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({
      last_login_at: new Date().toISOString(),
      last_login_ip: ipAddress
    })
    .eq('user_id', userId)

  if (error) throw error
}

// OTP

export async function createOtp(
  userId: string,
  email: string,
  codeHash: string,
  ipAddress?: string,
  expiresAt?: Date
): Promise<void> {
  await supabase
    .from('otp_codes')
    .update({ used: true })
    .eq('user_id', userId)
    .eq('used', false)

  const otpExpiry = expiresAt ?? new Date(Date.now() + 5 * 60 * 1000)

  const { error } = await supabase
    .from('otp_codes')
    .insert({
      user_id: userId,
      email,
      code: '',
      code_hash: codeHash,
      expires_at: otpExpiry.toISOString(),
      attempts: 0,
      ip_address: ipAddress,
    })

  if (error) throw error
}

export async function findValidOtp(
  userId: string,
  code: string
): Promise<OtpCode | null> {
  return findLatestOtp(userId)
}

export async function findLatestOtp(userId: string): Promise<OtpCode | null> {
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

export async function createSession(params: {
  user_id: string
  token: string
  refresh_token?: string
  expires_at: Date
  refresh_expires_at?: Date
  ip_address?: string
  device_info?: string
}): Promise<UserSession> {
  const { data, error } = await supabase
    .from('active_sessions')
    .insert({
      user_id: params.user_id,
      token: params.token,
      refresh_token: params.refresh_token,
      expires_at: params.expires_at.toISOString(),
      refresh_expires_at: params.refresh_expires_at?.toISOString(),
      ip_address: params.ip_address ?? null,
      device_info: params.device_info ?? null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function findActiveSession(tokenHash: string): Promise<UserSession | null> {
  const { data, error } = await supabase
    .from('active_sessions')
    .select('*')
    .eq('token', tokenHash)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

export async function findActiveSessionByRefreshToken(
  refreshTokenHash: string
): Promise<UserSession | null> {
  const { data, error } = await supabase
    .from('active_sessions')
    .select('*')
    .eq('refresh_token', refreshTokenHash)
    .gt('refresh_expires_at', new Date().toISOString())
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

export async function updateSessionAccessToken(
  sessionId: string,
  newTokenHash: string,
  expiresAt: Date
): Promise<void> {
  const { error } = await supabase
    .from('active_sessions')
    .update({
      token: newTokenHash,
      expires_at: expiresAt.toISOString()
    })
    .eq('id', sessionId)

  if (error) throw error
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

// LOGIN HISTORY - AUDIT TRAIL

export async function createLoginHistory(params: {
  user_id?: string
  email: string
  ip_address?: string
  device_info?: string
  user_agent?: string
  location_city?: string
  location_country?: string
  attempt_status: 'success' | 'failed_otp' | 'failed_locked' | 'failed_inactive' | 'failed_permanently_locked'
  failure_reason?: string
}): Promise<void> {
  const { error } = await supabase
    .from('login_history')
    .insert({
      user_id: params.user_id,
      email: params.email,
      ip_address: params.ip_address,
      device_info: params.device_info,
      user_agent: params.user_agent,
      location_city: params.location_city,
      location_country: params.location_country,
      attempt_status: params.attempt_status,
      failure_reason: params.failure_reason,
    })

  if (error) throw error
}

export async function getLoginHistory(
  userId: string,
  limit: number = 20
): Promise<LoginHistory[]> {
  const { data, error } = await supabase
    .from('login_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data ?? []
}

// TRUSTED DEVICE FINGERPRINTING

export async function upsertTrustedDevice(params: {
  user_id: string
  device_fingerprint: string
  device_name?: string
  trust_score?: number
  is_trusted?: boolean
}): Promise<void> {
  const { error } = await supabase
    .from('trusted_devices')
    .upsert({
      user_id: params.user_id,
      device_fingerprint: params.device_fingerprint,
      device_name: params.device_name || 'Unknown Device',
      trust_score: params.trust_score ?? 50,
      is_trusted: params.is_trusted ?? false,
      last_used_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id,device_fingerprint'
    })

  if (error) throw error
}

export async function getTrustedDevices(userId: string): Promise<TrustedDevice[]> {
  const { data, error } = await supabase
    .from('trusted_devices')
    .select('*')
    .eq('user_id', userId)
    .order('last_used_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function removeTrustedDevice(deviceId: string): Promise<void> {
  const { error } = await supabase
    .from('trusted_devices')
    .delete()
    .eq('id', deviceId)

  if (error) throw error
}

export async function detectSuspiciousLogin(
  userId: string,
  ipAddress?: string,
  deviceFingerprint?: string
): Promise<RiskAssessment> {
  const { data, error } = await supabase.rpc('detect_suspicious_login', {
    p_user_id: userId,
    p_ip_address: ipAddress || 'unknown',
    p_device_fingerprint: deviceFingerprint || 'unknown',
  })

  if (error) {
    return {
      risk_score: 0,
      risk_factors: [],
      requires_additional_verification: false,
    }
  }

  return data as RiskAssessment
}

export async function findUserWithClient(userId: string): Promise<AuthUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select(`
      user_id, email, username, first_name, last_name, role, status,
      clients (client_id, company_name, billing_address, payment_terms)
    `)
    .eq('user_id', userId)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  if (!data) return null

  return {
    ...data,
    clients: Array.isArray(data.clients) ? data.clients[0] ?? null : data.clients,
  } as AuthUser
}

export async function findUserWithDriver(userId: string): Promise<AuthUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select(`
      user_id, email, username, first_name, last_name, role, status,
      drivers (driver_id, license_number, license_expiry, status, is_vendor_driver)
    `)
    .eq('user_id', userId)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  if (!data) return null

  return {
    ...data,
    drivers: Array.isArray(data.drivers) ? data.drivers[0] ?? null : data.drivers,
  } as AuthUser
}