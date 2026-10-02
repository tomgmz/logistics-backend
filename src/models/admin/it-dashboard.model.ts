import { supabase } from '../../lib/supabase.js'

/**
 * Reads behind the IT Admin dashboard. Every log-table read here is either a
 * head-only count or a LIMIT-ed newest-first read, so the cost stays flat as
 * system_logs grows; the indexes on (timestamp), (event_type, timestamp),
 * (log_level, timestamp) and the partial unresolved index carry them.
 *
 * system_logs.timestamp and audit_logs.timestamp are `timestamp without time
 * zone` holding UTC. A filter value is passed as an ISO string, whose zone
 * suffix Postgres drops on the cast — which is the right answer for UTC data.
 */

const LOG_COLUMNS = 'log_id, log_level, event_type, source, message, timestamp'

type Filter = (q: any) => any

async function countRows(table: string, filter?: Filter): Promise<number> {
  let q = supabase.from(table).select('*', { count: 'exact', head: true })
  if (filter) q = filter(q)
  const { count, error } = await q
  if (error) throw error
  return count ?? 0
}

export const countSystemLogs  = (filter?: Filter) => countRows('system_logs', filter)
export const countAuditLogs   = (filter?: Filter) => countRows('audit_logs', filter)
export const countLoginHistory = (filter?: Filter) => countRows('login_history', filter)
export const countResetRequests = (filter?: Filter) => countRows('password_reset_requests', filter)
export const countPasskeys    = (filter?: Filter) => countRows('webauthn_credentials', filter)
export const countSessions    = (filter?: Filter) => countRows('active_sessions', filter)

/** Newest system_logs rows matching `filter`. */
export async function latestSystemLogs(filter: Filter, limit: number) {
  const { data, error } = await filter(
    supabase.from('system_logs').select(LOG_COLUMNS),
  )
    .order('timestamp', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as Array<{
    log_id: string; log_level: string; event_type: string
    source: string; message: string; timestamp: string
  }>
}

/** Emails behind failed sign-ins since `sinceIso`, capped so a burst stays cheap. */
export async function failedSignInEmails(sinceIso: string, cap: number): Promise<string[]> {
  const { data, error } = await supabase
    .from('login_history')
    .select('email')
    .neq('attempt_status', 'success')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(cap)
  if (error) throw error
  return (data ?? []).map((r) => r.email as string).filter(Boolean)
}

export interface UserRow {
  user_id:       string
  email:         string
  role:          string
  status:        string
  first_name:    string | null
  last_name:     string | null
  locked_until:  string | null
  last_login_at: string | null
  created_at:    string | null
}

/**
 * Every user, narrow columns. users is a staff-and-client directory, not a log;
 * it is small and the role/status breakdown needs every row anyway.
 */
export async function allUsers(): Promise<UserRow[]> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, role, status, first_name, last_name, locked_until, last_login_at, created_at')
  if (error) throw error
  return (data ?? []) as UserRow[]
}

export async function latestAuditByAction(action: string) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('description, timestamp')
    .eq('action', action)
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data as { description: string; timestamp: string } | null
}
