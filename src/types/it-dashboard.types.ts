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

/** One open issue in the dashboard queue (log_id = its newest row). */
export interface DashboardIssueRow extends DashboardLogRow {
  issue_id:    string
  event_count: number
  first_seen:  string
  regressed:   boolean
}

/**
 * A: the triage queue. Since 2026-11-21 it counts ISSUES (repeated errors
 * grouped, Sentry-style), not rows. `unresolved.warn` is warnings logged in
 * the last 24 hours: warnings are never grouped or resolved.
 */
export interface ProblemsSection {
  unresolved: { critical: number; error: number; warn: number }
  /** Rows logged in the last 24 hours, resolved or not: the metric cards' badges. */
  last_24h:   { critical: number; error: number; warn: number }
  /** Open issues, critical first, then most recently seen. */
  latest:     DashboardIssueRow[]
  /** All open issues (the "View all" count). */
  open_issues: number
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
  /** Company Administrator standing in for a departed IT Administrator (2026-11-06), else null. */
  it_standin:         StaffAccount | null
  last_handover:      { at: string; description: string } | null
  administrators:     StaffAccount[]
}

/**
 * Plain-language health, for a reader with no IT knowledge (user 2026-11-21).
 * Modelled on Apple's System Status and Atlassian Statuspage: one line per
 * part of the system, a word for its state, one sentence of why.
 */
export type HealthState = 'working' | 'trouble' | 'down' | 'unknown'

export interface HealthPart {
  key:     string
  /** What a user would call it: "Emails", "Maps and directions". */
  name:    string
  /** What it does for people, one short line. */
  what:    string
  state:   HealthState
  /** Why, in a sentence: "3 emails could not be sent in the last hour." */
  summary: string
  /** Last time something went wrong, if ever (last 7 days). */
  last_problem_at: string | null
}

/** One bucket of request counts (hour or minute). */
export interface TrafficPoint {
  start:    string
  requests: number
  failed:   number
  avg_ms:   number | null
}

/**
 * Traffic, failures and wait time (Google SRE's golden signals), from
 * api_request_minutes. `failed` = the system failed the request (5xx);
 * `refused` = turned away on purpose (wrong password, no permission).
 */
export interface TrafficWindow {
  requests: number
  failed:   number
  refused:  number
  avg_ms:   number | null
  /** Requests that took 3 seconds or more. */
  slow:     number
}

export interface TrafficSection {
  last_15m: TrafficWindow
  last_24h: TrafficWindow
  /** Average database answer time over the last 15 minutes, ms. */
  db_avg_ms:      number | null
  db_failures_15m: number
  /** 24 hourly points, oldest first (Manila hours). */
  hourly:   TrafficPoint[]
  /** First minute ever measured; null = measuring has not started yet. */
  measured_since: string | null
}

export interface ItDashboardSummary {
  generated_at: string
  /** The plain-language overview (top of the page). */
  health:       HealthPart[]
  traffic:      TrafficSection
  problems:     ProblemsSection
  schedulers:   SchedulerHealth[]
  services:     ServiceHealth[]
  security:     SecuritySection
  accounts:     AccountsSection
}

/** The chart's time windows, as Untitled UI's dashboard-04 offers them. */
export type TrendRange = '12m' | '30d' | '7d' | '24h'
export type TrendLevel = 'critical' | 'error' | 'warn'

/**
 * system_logs rows of one level per bucket (hours for 24h, days for 7d/30d,
 * months for 12m), bucketed on Manila time, oldest first. The newest bucket is
 * the current one, still filling.
 */
export interface ItDashboardTrend {
  range:          TrendRange
  level:          TrendLevel
  buckets:        { start: string; count: number }[]
  total:          number
  /** The same length of time just before the range, for the change badge. */
  previous_total: number
}
