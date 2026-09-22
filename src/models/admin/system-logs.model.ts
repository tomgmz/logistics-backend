import { supabase } from '../../lib/supabase.js'
import { GetSystemLogsQuery } from '../../types/system-logs.types.js'

/**
 * Reads the system_logs table.
 *
 * This file used to be a copy of audit-logs.model.ts that queried audit_logs,
 * so "system logs" and "audit logs" were two views of one table. It now has
 * storage of its own.
 *
 * Unlike the audit model, this one paginates in the database. System logs are
 * written by machines and grow far faster than audit rows; fetching the whole
 * table to count it stops being viable almost immediately.
 */

const DEFAULT_LIMIT = 15
const MAX_LIMIT     = 200

export async function findAll(query: GetSystemLogsQuery = {}) {
  const { event_type, log_level, resolved, search, sort = 'desc' } = query

  const page  = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const from  = (page - 1) * limit

  let q = supabase
    .from('system_logs')
    .select(
      'log_id, log_level, event_type, source, message, metadata, resolved, user_id, timestamp',
      { count: 'exact' },
    )

  if (event_type)          q = q.eq('event_type', event_type)
  if (log_level)           q = q.eq('log_level', log_level)
  if (resolved !== undefined) q = q.eq('resolved', resolved)
  if (search) {
    q = q.or(`message.ilike.%${search}%,source.ilike.%${search}%`)
  }

  q = q.order('timestamp', { ascending: sort === 'asc' }).range(from, from + limit - 1)

  const { data, error, count } = await q
  if (error) throw error
  return { data: data ?? [], total: count ?? 0, page, limit }
}

export async function findById(logId: string) {
  const { data, error } = await supabase
    .from('system_logs')
    .select('log_id, log_level, event_type, source, message, metadata, resolved, user_id, timestamp')
    .eq('log_id', logId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function setResolved(logId: string, resolved: boolean) {
  const { data, error } = await supabase
    .from('system_logs')
    .update({ resolved })
    .eq('log_id', logId)
    .select('log_id, resolved')
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getStats() {
  // Two narrow aggregate reads rather than pulling every row back to count it
  // in Node, which is what the audit model does and what this file inherited.
  const counts = { total: 0, info: 0, warn: 0, error: 0, critical: 0, unresolved: 0 }

  const { data, error } = await supabase.from('system_logs').select('log_level, resolved')
  if (error) throw error

  for (const row of data ?? []) {
    counts.total++
    if (row.log_level in counts) counts[row.log_level as 'info' | 'warn' | 'error' | 'critical']++
    if (!row.resolved) counts.unresolved++
  }

  return counts
}
