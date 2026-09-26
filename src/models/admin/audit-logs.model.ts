import { supabase } from '../../lib/supabase.js'
import { GetLogsQuery } from '../../types/audit-logs.types.js'
import { readInPages } from '../../lib/read-in-pages.js'

// The list and the export share this, so "export what I'm looking at" really
// does export the same filtered, same-ordered rows.
function filteredQuery({ log_type, search, sort = 'desc' }: GetLogsQuery) {
  let q = supabase
    .from('audit_logs')
    .select(`
      log_id,
      user_id,
      log_type,
      action,
      description,
      timestamp,
      users ( role, first_name, last_name )
    `)

  if (log_type) q = q.eq('log_type', log_type)
  if (search) {
    q = q.or(`action.ilike.%${search}%,description.ilike.%${search}%`)
  }
  return q.order('timestamp', { ascending: sort === 'asc' })
}

export async function findAll(query: GetLogsQuery = {}) {
  const { data, error } = await filteredQuery(query)
  if (error) throw error
  return { data, total: data?.length ?? 0, page: 1, limit: data?.length ?? 0 }
}

export async function findForExport(query: GetLogsQuery, cap: number) {
  return readInPages(
    // log_id breaks timestamp ties so paging never skips or repeats a row.
    (from, to) => filteredQuery(query).order('log_id').range(from, to),
    cap,
  )
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
    auth:                 0,
    user_management:      0,
    access_control:       0,
    document_activity:    0,
    data_export:          0,
    admin_activity:       0,
    vehicle_creation:     0,
    vehicle_activity:     0,
    booking:              0,
    driver_activity:      0,
    delivery_activity:    0,
    maintenance_activity: 0,
    // Kept so pre-split rows still count toward a bucket rather than silently
    // vanishing from the stat tiles.
    user_activity:        0,
    system_error:         0,
  }

  for (const row of data ?? []) {
    counts.total++
    if (row.log_type in counts) counts[row.log_type]++
  }

  return counts
}
