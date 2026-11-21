import { supabase } from '../../lib/supabase.js'
import { searchOrFilters } from '../../lib/paginate.js'
import { readableLogs } from '../../lib/log-text.js'
import {
  GetSystemLogIssuesQuery,
  SystemLogIssue,
  SystemLogIssueStatus,
} from '../../types/system-logs.types.js'

/**
 * Reads and closes system_log_issues: repeated error/critical system log rows
 * grouped by fingerprint. Rows are grouped by the system_logs_group_issue
 * trigger (migration 20261121050000), never from here, so every writer is
 * covered and two processes logging the same error at once cannot race.
 */

const COLUMNS =
  'issue_id, log_level, event_type, source, title, last_message, last_log_id, status, ' +
  'event_count, first_seen, last_seen, resolved_at, resolved_by, resolution, ' +
  'ignored_until, ignored_by, regressed_at, times_regressed, count_while_ignored'

const DEFAULT_LIMIT = 20
const MAX_LIMIT     = 100

function fullName(u: { first_name?: string | null; last_name?: string | null } | undefined) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || null
}

/** The newest message read as words (ids → names), and who closed it. */
async function readable(rows: Array<Record<string, any>>): Promise<SystemLogIssue[]> {
  if (!rows.length) return []
  const withText = await readableLogs(rows.map((r) => ({ ...r, message: r.last_message })), 'message')

  const ids = [...new Set(rows.flatMap((r) => [r.resolved_by, r.ignored_by]).filter(Boolean))] as string[]
  const names = new Map<string, string | null>()
  if (ids.length) {
    const { data } = await supabase.from('users').select('user_id, first_name, last_name').in('user_id', ids)
    for (const u of data ?? []) names.set(u.user_id, fullName(u))
  }

  return (withText as Array<Record<string, any>>).map(({ message, ...r }) => ({
    ...r,
    last_message:     message,
    resolved_by_name: r.resolved_by ? names.get(r.resolved_by) ?? null : null,
  })) as SystemLogIssue[]
}

export async function findAll(query: GetSystemLogIssuesQuery = {}) {
  const page  = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const from  = (page - 1) * limit

  let q = supabase.from('system_log_issues').select(COLUMNS, { count: 'exact' })
  if (query.status)     q = q.eq('status', query.status)
  if (query.log_level)  q = q.eq('log_level', query.log_level)
  if (query.event_type) q = q.eq('event_type', query.event_type)
  // "Search source or message": the grouped title and the newest message.
  for (const f of searchOrFilters(query.search ?? '', ['source', 'title', 'last_message'])) q = q.or(f)

  const { data, error, count } = await q
    .order('last_seen', { ascending: query.sort === 'asc' })
    .order('issue_id')
    .range(from, from + limit - 1)
  if (error) throw error
  return { data: await readable((data ?? []) as unknown as Array<Record<string, any>>), total: count ?? 0, page, limit }
}

export async function findById(issueId: string): Promise<SystemLogIssue | null> {
  const { data, error } = await supabase.from('system_log_issues').select(COLUMNS).eq('issue_id', issueId).maybeSingle()
  if (error) throw error
  return data ? (await readable([data as unknown as Record<string, any>]))[0] : null
}

/** The issue a log row belongs to, if any (the old per-row Resolve route). */
export async function issueIdOfLog(logId: string): Promise<string | null | undefined> {
  const { data, error } = await supabase.from('system_logs').select('issue_id').eq('log_id', logId).maybeSingle()
  if (error) throw error
  return data ? (data.issue_id as string | null) : undefined
}

/**
 * Sets the status. Resolving an issue that reopened since the screen loaded
 * still resolves it (the person saw it and closed it); the next occurrence
 * reopens it again as a regression.
 */
export async function setStatus(
  issueId: string,
  patch: {
    status:         SystemLogIssueStatus
    resolved_at?:   string | null
    resolved_by?:   string | null
    resolution?:    'manual' | 'auto' | null
    ignored_until?: string | null
    ignored_by?:    string | null
  },
) {
  const { data, error } = await supabase
    .from('system_log_issues')
    .update(patch)
    .eq('issue_id', issueId)
    .select(COLUMNS)
    .maybeSingle()
  if (error) throw error
  return data ? (await readable([data as unknown as Record<string, any>]))[0] : null
}

/** Open issues that have been quiet since `before` close themselves. Returns how many. */
export async function autoResolveQuietSince(before: string): Promise<number> {
  const { data, error } = await supabase
    .from('system_log_issues')
    .update({ status: 'resolved', resolution: 'auto', resolved_at: new Date().toISOString(), resolved_by: null })
    .eq('status', 'open')
    .lt('last_seen', before)
    .select('issue_id')
  if (error) throw error
  return data?.length ?? 0
}

/** Head-only count of issues matching `filter`. */
export async function count(filter?: (q: any) => any): Promise<number> {
  let q = supabase.from('system_log_issues').select('issue_id', { count: 'exact', head: true })
  if (filter) q = filter(q)
  const { count: n, error } = await q
  if (error) throw error
  return n ?? 0
}

/** Newest open issues first, for the dashboard queue. */
export async function latestOpen(limit: number) {
  const { data, error } = await supabase
    .from('system_log_issues')
    .select(COLUMNS)
    .eq('status', 'open')
    .order('log_level', { ascending: true }) // 'critical' sorts before 'error'
    .order('last_seen', { ascending: false })
    .limit(limit)
  if (error) throw error
  return readable((data ?? []) as unknown as Array<Record<string, any>>)
}
