export interface OtpCode {
  id: string
  user_id: string
  email: string
  code: string 
  code_hash?: string 
  expires_at: Date
  used: boolean
  attempts: number
  ip_address?: string
  blocked_until?: Date
  created_at: Date
}

export interface UserSession {
  id: string
  user_id: string
  token: string 
  refresh_token?: string 
  device_info?: string | null
  ip_address?: string | null
  created_at: Date
  last_active_at: Date
  expires_at: Date
  refresh_expires_at?: Date
  token_version?: number
}

export interface AuthUser {
  user_id: string
  email: string
  username: string
  first_name: string | null
  last_name: string | null
  role: string
  status: string
  failed_login_attempts?: number
  locked_until?: Date | null
  last_login_at?: Date | null
  last_login_ip?: string | null
}

export interface LoginHistory {
  id: string
  user_id?: string
  email: string
  ip_address?: string
  device_info?: string
  user_agent?: string
  location_city?: string
  location_country?: string
  attempt_status: 'success' | 'failed_otp' | 'failed_locked' | 'failed_inactive'
  failure_reason?: string
  created_at: Date
}

export interface TrustedDevice {
  id: string
  user_id: string
  device_fingerprint: string
  device_name?: string
  last_used_at: Date
  trust_score: number
  is_trusted: boolean
  created_at: Date
}

export interface RiskAssessment {
  risk_score: number
  risk_factors: Array<{
    type: string
    count?: number
  }>
  requires_additional_verification: boolean
}

export interface RequestOtpInput {
  email: string
}

export interface VerifyOtpInput {
  email: string
  code: string
  device_info?: string
}

export interface RefreshTokenInput {
  refreshToken: string
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
  refreshExpiresAt: string
  user: AuthUser
}

export interface RefreshTokenResponse {
  accessToken: string
  accessExpiresAt: string
}