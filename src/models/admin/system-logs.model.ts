import { supabase } from '../../lib/supabase.js'
import { GetLogsQuery } from '../../types/system-logs.types.js'

export async function findAll(query: GetLogsQuery = {}) {
  const { log_type, search, sort = 'desc', page = 1, limit = 20 } = query
  const offset = (page - 1) * limit

  let q = supabase
    .from('system_logs')
    .select(`
      log_id,
      user_id,
      log_type,
      action,
      description,
      ip_address,
      timestamp,
      users ( username, role, first_name, last_name )
    `, { count: 'exact' })

  if (log_type) q = q.eq('log_type', log_type)

  if (search) {
    q = q.or(`action.ilike.%${search}%,description.ilike.%${search}%`)
  }

  q = q
    .order('timestamp', { ascending: sort === 'asc' })
    .range(offset, offset + limit - 1)

  const { data, error, count } = await q
  if (error) throw error

  return { data, total: count ?? 0, page, limit }
}

export async function findById(logId: string) {
  const { data, error } = await supabase
    .from('system_logs')
    .select(`
      log_id,
      user_id,
      log_type,
      action,
      description,
      ip_address,
      timestamp,
      users ( username, role, first_name, last_name )
    `)
    .eq('log_id', logId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getStats() {
  const { data, error } = await supabase
    .from('system_logs')
    .select('log_type')

  if (error) throw error

  const counts: Record<string, number> = {
    total:          0,
    user_activity:  0,
    truck_activity: 0,
    booking:        0,
    payment:        0,
    system_error:   0,
  }

  for (const row of data ?? []) {
    counts.total++
    if (row.log_type in counts) counts[row.log_type]++
  }

  return counts
}