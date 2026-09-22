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
  /** Cloudinary, Google Maps, OCR, push delivery. */
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
  resolved:    boolean
  user_id?:    string | null
  timestamp:   Date
}

export interface GetSystemLogsQuery {
  event_type?: SystemLogEventType
  log_level?:  SystemLogLevel
  resolved?:   boolean
  search?:     string
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
  unresolved: number
}
