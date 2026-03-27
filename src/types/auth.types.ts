export interface OtpCode {
  id:         string
  user_id:    string
  email:      string
  code:       string
  expires_at: Date
  used:       boolean
  attempts:   number  // ✅ now exists in DB
  created_at: Date
}

export interface UserSession {
  id:             string
  user_id:        string
  token:          string  // stores SHA-256 hash now
  device_info?:   string | null
  ip_address?:    string | null
  created_at:     Date
  last_active_at: Date
  expires_at:     Date
}

export interface RequestOtpInput {
  email: string
}

export interface VerifyOtpInput {
  email:        string
  code:         string
  device_info?: string
}

export interface AuthUser {
  user_id:    string
  email:      string
  username:   string
  first_name: string | null
  last_name:  string | null
  role:       string
  status:     string
}

export interface AuthResponse {
  token:   string
  user:    AuthUser
  expires: string
}