/**
 * The IT Admin dashboard: one read that answers "is the system healthy and
 * secure right now, and is anything waiting for me". Every number is derived
 * from tables that already exist — system_logs, audit_logs, login_history,
 * active_sessions, password_reset_requests, webauthn_credentials, users.
 *
 * Nothing here carries an IP address, by the never-log-user-IPs rule.
 */
import { SystemLogLevel, SystemLogEventType } from './system-logs.types.js'

export interface DashboardLogRow {
  log_id:     string
  log_level:  SystemLogLevel
  event_type: SystemLogEventType
  source:     string
  message:    string
  timestamp:  string
}

/** A: the triage queue. */
export interface ProblemsSection {
  unresolved: { critical: number; error: number; warn: number }
  /** Newest unresolved critical/error rows, newest first. */
  latest:     DashboardLogRow[]
}

/**
 * B: one row per scheduler. `late` = the heartbeat is overdue; `down` = it has
 * been missing for long enough that the process is almost certainly not running
 * it; `failing` = its newest row is an error, newer than its last heartbeat.
 */
export type SchedulerStatus = 'ok' | 'failing' | 'late' | 'down' | 'never'

export interface SchedulerHealth {
  source:             string
  label:              string
  description:        string
  interval_minutes:   number
  status:             SchedulerStatus
  last_success_at:    string | null
  last_success_note:  string | null
  last_error_at:      string | null
  last_error_message: string | null
  errors_24h:         number
}

/**
 * C: external providers. Only failures are logged, so the honest green state
 * is "no failures recorded", never "up".
 */
export type ServiceStatus = 'ok' | 'degraded' | 'failing'

export interface ServiceHealth {
  key:                  string
  label:                string
  description:          string
  status:               ServiceStatus
  failures_1h:          number
  failures_24h:         number
  failures_7d:          number
  last_failure_at:      string | null
  last_failure_message: string | null
}

/** D: sign-in and session activity over one window. */
export interface SecurityWindow {
  failed_sign_ins:      number
  lockouts:             number
  rate_limit_trips:     number
  critical_auth_alerts: number
  passkey_failures:     number
  reset_requests:       number
  passkeys_enrolled:    number
  sessions_revoked:     number
}

export interface LockedAccount {
  user_id:      string
  name:         string
  email:        string
  role:         string
  permanent:    boolean
  locked_until: string | null
}

export interface SecuritySection {
  last_24h:             SecurityWindow
  last_7d:              SecurityWindow
  /** Accounts with the most failed sign-ins in the last 24h. Email only. */
  most_failed_accounts: { email: string; count: number }[]
  locked_accounts:      LockedAccount[]
  open_reset_requests:  number
  active_sessions:      number
}

/** E: who has an account, and who holds the keys. */
export interface RoleCounts {
  role:               string
  active:             number
  inactive:           number
  archived:           number
  permanently_locked: number
  total:              number
}

export interface StaffAccount {
  user_id:       string
  name:          string
  email:         string
  status:        string
  last_login_at: string | null
  created_at:    string | null
}

export interface AccountsSection {
  by_role:            RoleCounts[]
  total_active:       number
  /** Active accounts that have never signed in. */
  never_signed_in:    number
  /** Active accounts whose last sign-in is older than DORMANT_DAYS. */
  dormant:            number
  dormant_days:       number
  it_admin:           StaffAccount | null
  last_handover:      { at: string; description: string } | null
  administrators:     StaffAccount[]
}

export interface ItDashboardSummary {
  generated_at: string
  problems:     ProblemsSection
  schedulers:   SchedulerHealth[]
  services:     ServiceHealth[]
  security:     SecuritySection
  accounts:     AccountsSection
}
