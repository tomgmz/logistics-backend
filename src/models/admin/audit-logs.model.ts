import { supabase } from '../../lib/supabase.js'
import { GetLogsQuery } from '../../types/audit-logs.types.js'

export async function findAll(query: GetLogsQuery = {}) {
  const { log_type, search, sort = 'desc' } = query

  let q = supabase
    .from('audit_logs')
    .select(`
      log_id,
      user_id,
      log_type,
      action,
      description,
      ip_address,
      timestamp,
      users ( role, first_name, last_name )
    `)

  if (log_type) q = q.eq('log_type', log_type)
  if (search) {
    q = q.or(`action.ilike.%${search}%,description.ilike.%${search}%`)
  }
  q = q.order('timestamp', { ascending: sort === 'asc' })

  const { data, error } = await q
  if (error) throw error
  return { data, total: data?.length ?? 0, page: 1, limit: data?.length ?? 0 }
}

export async function findById(logId: string) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select(`
      log_id,
      user_id,
      log_type,
      action,
      description,
      ip_address,
      timestamp,
      users ( role, first_name, last_name )
    `)
    .eq('log_id', logId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getStats() {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('log_type')

  if (error) throw error

  const counts: Record<string, number> = {
    total:                0,
    user_activity:        0,
    vehicle_creation:     0,
    vehicle_activity:     0,
    booking:              0,
    payment:              0,
    system_error:         0,
    driver_activity:      0,
    billing_activity:     0,
    delivery_activity:    0,
    maintenance_activity: 0,
    auth:                 0,
  }

  for (const row of data ?? []) {
    counts.total++
    if (row.log_type in counts) counts[row.log_type]++
  }

  return counts
}
