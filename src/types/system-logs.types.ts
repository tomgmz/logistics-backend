/**
 * Technical system log. Every row here answers "what did the software do, or
 * fail to do". Most have no human actor. Anything attributable to a person
 * acting on a business record belongs in audit-logs.types.ts instead.
 */
export type SystemLogLevel = 'info' | 'warn' | 'error' | 'critical'

export type SystemLogEventType =
  /** An unhandled throw reached the global error handler. */
  | 'server_error'
  /** Failed login, rate limit tripped, token reuse, lockout. */
  | 'auth_event'
  /** Outbound mail accepted or rejected by the provider. */
  | 'email_event'
  /** File storage (R2), Google Maps, OCR, push delivery. */
  | 'external_api'
  /** Scheduler ticks — including successful ones, so a dead cron is visible. */
  | 'cron_job'
  /** Supabase/Postgres errors, including ones previously swallowed. */
  | 'db_event'

export interface SystemLog {
  log_id:      string
  log_level:   SystemLogLevel
  event_type:  SystemLogEventType
  source:      string
  message:     string
  metadata?:   Record<string, unknown> | null
  /** @deprecated Error/critical rows are resolved through their issue; see SystemLogIssue. */
  resolved:    boolean
  user_id?:    string | null
  timestamp:   Date
  /** The issue an error/critical row was grouped into; null for info/warn. */
  issue_id?:   string | null
}

export interface GetSystemLogsQuery {
  /** Only the rows grouped into this issue. */
  issue_id?:   string
  event_type?: SystemLogEventType
  log_level?:  SystemLogLevel
  resolved?:   boolean
  search?:     string
  /** Manila days, YYYY-MM-DD, inclusive. */
  from?:       string
  to?:         string
  sort?:       'asc' | 'desc'
  page?:       number
  limit?:      number
}

export interface SystemLogStats {
  total:      number
  info:       number
  warn:       number
  error:      number
  critical:   number
  /** Open issues (grouped error/critical), not rows. */
  unresolved: number
}

/**
 * Repeated error/critical rows grouped by fingerprint (Sentry-style). The issue
 * is what an IT Administrator resolves; the rows stay as they were written.
 * Grouping happens in the database (system_logs_group_issue trigger).
 */
export type SystemLogIssueStatus = 'open' | 'resolved' | 'ignored'

export interface SystemLogIssue {
  issue_id:            string
  log_level:           'error' | 'critical'
  event_type:          SystemLogEventType
  source:              string
  title:               string
  last_message:        string
  last_log_id:         string | null
  status:              SystemLogIssueStatus
  event_count:         number
  first_seen:          string
  last_seen:           string
  resolved_at:         string | null
  resolved_by:         string | null
  resolved_by_name?:   string | null
  resolution:          'manual' | 'auto' | null
  ignored_until:       string | null
  ignored_by:          string | null
  regressed_at:        string | null
  times_regressed:     number
  count_while_ignored: number
}

export interface GetSystemLogIssuesQuery {
  status?:     SystemLogIssueStatus
  log_level?:  'error' | 'critical'
  event_type?: SystemLogEventType
  search?:     string
  sort?:       'desc' | 'asc'
  page?:       number
  limit?:      number
}

/** resolve | reopen | ignore (hours = how long; null/absent = until reopened by hand). */
export type SystemLogIssueAction =
  | { action: 'resolve' }
  | { action: 'reopen' }
  | { action: 'ignore'; hours?: number | null }
