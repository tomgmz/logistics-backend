import { supabase } from '../../lib/supabase.js'
import { GetLogsQuery } from '../../types/audit-logs.types.js'
import { readInPages } from '../../lib/read-in-pages.js'
import { searchOrFilters, searchWords } from '../../lib/paginate.js'

/**
 * For each word of the search, the users whose first or last name holds it:
 * the search box reads "Search name, action or description", and the name is
 * the acting user's, which lives on users, not on the log row.
 */
async function nameMatches(search: string | undefined): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const word of searchWords(search ?? '')) {
    const [filter] = searchOrFilters(word, ['first_name', 'last_name'])
    if (!filter) continue
    const { data, error } = await supabase.from('users').select('user_id').or(filter).limit(500)
    if (error) throw error
    out.set(word.replace(/[,()%_*\\"]/g, ''), (data ?? []).map((u) => u.user_id as string))
  }
  return out
}

// The list and the export share this, so "export what I'm looking at" really
// does export the same filtered, same-ordered rows.
function filteredQuery(
  { log_type, search, from, to, sort = 'desc' }: GetLogsQuery,
  names: Map<string, string[]>,
  options?: { count: 'exact' },
) {
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
    `, options)

  if (log_type) q = q.eq('log_type', log_type)
  // Whole Manila days (+08:00), both ends included.
  if (from) q = q.gte('timestamp', `${from}T00:00:00+08:00`)
  if (to)   q = q.lte('timestamp', `${to}T23:59:59.999+08:00`)
  // Every word must be in the user's name, the action or the description.
  for (const f of searchOrFilters(search ?? '', ['action', 'description'], (word) => {
    const ids = names.get(word) ?? []
    return ids.length ? [`user_id.in.(${ids.join(',')})`] : []
  })) q = q.or(f)
  return q.order('timestamp', { ascending: sort === 'asc' })
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT     = 200

// Paginated in the database, like system_logs: reading the whole table to
// slice it in the browser also hit PostgREST's 1000-row ceiling silently.
export async function findAll(query: GetLogsQuery = {}) {
  const page  = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const from  = (page - 1) * limit

  const names = await nameMatches(query.search)
  const { data, error, count } = await filteredQuery(query, names, { count: 'exact' })
    // log_id breaks timestamp ties so a row never sits on two pages.
    .order('log_id')
    .range(from, from + limit - 1)
  if (error) throw error
  return { data: data ?? [], total: count ?? 0, page, limit }
}

export async function findForExport(query: GetLogsQuery, cap: number) {
  const names = await nameMatches(query.search)
  return readInPages(
    // log_id breaks timestamp ties so paging never skips or repeats a row.
    (from, to) => filteredQuery(query, names).order('log_id').range(from, to),
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
