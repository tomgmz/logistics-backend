import { supabase } from './supabase.js'

/**
 * Turns stored log text into what a person reads (audit descriptions and
 * system messages alike). The stored row is never changed: this runs on the
 * way out, for the list and the export, so older rows read the same as new
 * ones and a wording fix applies to the whole history.
 *
 * - record ids become names: a person, a client's company, a vehicle's plate,
 *   a booking's reference, a model's name; an id that is no longer on file
 *   reads "(no longer on file)"
 * - ISO times and dates become Philippine time ("Oct 17, 2026, 11:08 AM")
 * - code words become words ("under_maintenance" → "Under Maintenance",
 *   "admin" → "Company Administrator"), "->" becomes "→"
 * - "1 document(s)" becomes "1 document", "2 trip(s)" "2 trips"
 * - "filters: {json}" becomes "filters: sort newest first, …"
 * - distances over 1 km read in km
 */

const UUID_RX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

const ROLE_LABEL: Record<string, string> = {
  admin:              'Company Administrator',
  it_admin:           'IT Administrator',
  general_manager:    'General Manager',
  gm:                 'General Manager',
  operations_manager: 'Operations Manager',
  operations_admin:   'Operations Manager',
  fleet_manager:      'Fleet Manager',
  fleet_admin:        'Fleet Manager',
  client:             'Client',
  driver:             'Driver',
  company_admin:      'Company Administrator',
}

// snake_case words that show up in stored text. Matched as whole words only.
const CODE_WORDS: Record<string, string> = {
  under_maintenance: 'Under Maintenance',
  proof_of_delivery: 'Proof of Delivery',
  in_use:            'In Use',
  in_transit:        'In Transit',
  recheck_due:       'Re-check Due',
  out_of_service:    'Out of Service',
  pending_approval:  'Pending Approval',
  can_view:          'view',
  can_edit:          'edit',
  can_create:        'create',
  can_delete:        'archive',
  can_export:        'export',
  company_admin:     'Company Administrator',
  it_admin:          'IT Administrator',
  general_manager:   'General Manager',
  operations_manager:'Operations Manager',
  operations_admin:  'Operations Manager',
  fleet_manager:     'Fleet Manager',
  fleet_admin:       'Fleet Manager',
  'user-management': 'User Management',
  'audit-logs':      'Audit Logs',
}

const MANILA_DATE_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
})
const PLAIN_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
})

const cap = (w: string) => w.split(' ').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')

function plural(word: string, n: number): string {
  if (n === 1) return word
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

const FILTER_KEY: Record<string, string> = {
  log_type: 'type', event_type: 'event', log_level: 'level', clientIds: 'clients',
  dateBasis: 'date by', dateFrom: 'from', dateTo: 'to', archived: 'archived', keys: 'files',
}

function readableFilters(json: string): string | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>
    const parts = Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => {
        if (k === 'sort') return v === 'asc' ? 'oldest first' : 'newest first'
        const key = FILTER_KEY[k] ?? k.replace(/_/g, ' ')
        const val = Array.isArray(v) ? `${v.length} selected` : String(v).replace(/_/g, ' ')
        return `${key} ${val}`
      })
    return parts.length ? parts.join(', ') : 'none'
  } catch {
    return null
  }
}

/** Text-only clean-up, no lookups. `names` maps a lowercased id to its name. */
export function tidyLogText(raw: string, names: Map<string, string> = new Map()): string {
  let s = raw

  // Ids that only ever named a request/message nobody reads by id: drop them.
  s = s.replace(new RegExp(`^Reset request ${UUID_RX.source}`, 'i'), 'Reset request')
  s = s.replace(new RegExp(`,? ?\\brequest ${UUID_RX.source}`, 'gi'), '')
  // An id inside a request path, or a stored file named by its id.
  s = s.replace(new RegExp(`/${UUID_RX.source}`, 'gi'), '/…')
  s = s.replace(new RegExp(`${UUID_RX.source}\\.\\w{2,5}\\b`, 'gi'), 'an uploaded file')
  s = s.replace(new RegExp(`Unsent message ${UUID_RX.source}`, 'gi'), 'Unsent a message')
  s = s.replace(new RegExp(`\\(user: ${UUID_RX.source}\\)`, 'gi'), '')

  // "filters: {...}"
  s = s.replace(/filters: (\{.*\})/i, (m, json: string) => {
    const r = readableFilters(json)
    return r ? `filters: ${r}` : m
  })

  // Record ids → names.
  s = s.replace(UUID_RX, (id) => names.get(id.toLowerCase()) ?? '(no longer on file)')

  // ISO date-times, then bare dates.
  s = s.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g, (iso) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : MANILA_DATE_TIME.format(d)
  })
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d))
    return Number.isNaN(dt.getTime()) ? m : PLAIN_DATE.format(dt)
  })
  // "in 2026-10" (a month)
  s = s.replace(/\bin (\d{4})-(\d{2})\b/g, (m, y, mo) => {
    const dt = new Date(Date.UTC(+y, +mo - 1, 1))
    return Number.isNaN(dt.getTime()) ? m : `in ${dt.toLocaleString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })}`
  })

  // "N thing(s)"
  s = s.replace(/\b(\d[\d,]*) ((?:[a-z_]+ ){0,2})([a-z-]+)\(s\)/gi, (_m, n: string, mid: string, w: string) =>
    `${n} ${mid}${plural(w, Number(n.replace(/,/g, '')))}`)
  s = s.replace(/\(s\)/g, 's')

  // Distances in metres over 1 km.
  s = s.replace(/\b(\d{4,}) m\b/g, (_m, n: string) => `${(Number(n) / 1000).toFixed(1)} km`)

  // "status changed from under_maintenance to available"
  s = s.replace(/status changed from ([a-z_]+) to ([a-z_]+)/, (_m, a: string, b: string) =>
    `status changed from ${CODE_WORDS[a] ?? cap(a.replace(/_/g, ' '))} to ${CODE_WORDS[b] ?? cap(b.replace(/_/g, ' '))}`)
  // "(requires: admin, it_admin)" → role names.
  s = s.replace(/\(requires: ([^)]*)\)/, (_m, list: string) =>
    `(requires: ${list.split(/,\s*/).map((r) => ROLE_LABEL[r] ?? r).join(', ')})`)
  // "denied can_edit on user-management (" → "… on User Management (".
  s = s.replace(/ on ([a-z]+(?:-[a-z]+)+)(?= \(|$)/g, (_m, k: string) => ` on ${cap(k.replace(/-/g, ' '))}`)
  // Code words.
  s = s.replace(/\b[a-z]+(?:[_-][a-z]+)+\b/g, (w) => CODE_WORDS[w] ?? w)
  // A role code in brackets or at the start ("(admin)", "admin denied …").
  s = s.replace(/\(([a-z_]+)\)/g, (m, r: string) => (ROLE_LABEL[r] ? `(${ROLE_LABEL[r]})` : m))
  s = s.replace(/^([a-z_]+) (denied|requested)\b/, (m, r: string, v: string) => (ROLE_LABEL[r] ? `${ROLE_LABEL[r]} ${v}` : m))
  s = s.replace(/ -> /g, ' → ')
  // Handling codes are no longer standard/additional on screen.
  s = s.replace(/^(Handling code \S+) \((?:standard|additional)\)/, '$1')

  // Words the screens no longer use.
  s = s.replace(/A crew member/g, 'A driver')
  // Older rows say just "Administrator" for the Company Administrator.
  s = s.replace(/(?<!Company |IT )\bAdministrator\b/g, 'Company Administrator')
  s = s.replace(/\bGM\b/g, 'General Manager')
  s = s.replace(/\bOps\b/g, 'Operations')

  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;)])/g, '$1').trim()
}

/**
 * Names for every record id in `texts`, read in a few batched queries. Ids
 * are looked up in each table that can hold them; the first hit wins.
 */
export async function namesForIds(texts: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = new Set<string>()
  for (const t of texts) for (const m of (t ?? '').matchAll(UUID_RX)) ids.add(m[0].toLowerCase())
  const names = new Map<string, string>()
  if (!ids.size) return names

  const fullName = (u: { first_name?: string | null; last_name?: string | null } | null | undefined) =>
    [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim()

  const lookups: Array<{ table: string; key: string; select: string; label: (r: any) => string }> = [
    { table: 'users',        key: 'user_id',    select: 'user_id, first_name, last_name, email', label: (r) => fullName(r) || r.email },
    { table: 'drivers',      key: 'driver_id',  select: 'driver_id, users!drivers_user_id_fkey ( first_name, last_name )', label: (r) => fullName(r.users) },
    { table: 'clients',      key: 'client_id',  select: 'client_id, company_name', label: (r) => r.company_name },
    { table: 'trucks',       key: 'truck_id',   select: 'truck_id, plate_number', label: (r) => r.plate_number },
    { table: 'bookings',     key: 'booking_id', select: 'booking_id, reference_number', label: (r) => r.reference_number },
    { table: 'truck_models', key: 'model_id',   select: 'model_id, name', label: (r) => r.name },
    { table: 'driver_reports', key: 'report_id', select: 'report_id', label: () => '' },
  ]

  // Every table is asked at once (each call is a round trip to the database;
  // one after another they added up to most of the page's wait). Results are
  // applied in the list's order, so an id found in two tables keeps the
  // earlier table's name, as before.
  const all = [...ids]
  const chunks: string[][] = []
  for (let i = 0; i < all.length; i += 150) chunks.push(all.slice(i, i + 150))

  const results = await Promise.all(lookups.map(({ table, key, select }) =>
    Promise.all(chunks.map(async (chunk) => {
      const { data, error } = await supabase.from(table).select(select).in(key, chunk)
      // A lookup that fails leaves the id unnamed; the log still reads.
      if (error) { console.error('[log-text]', table, error.message); return [] as any[] }
      return (data ?? []) as any[]
    })).then((parts) => parts.flat()),
  ))

  lookups.forEach(({ key, label }, i) => {
    for (const r of results[i]) {
      const id = String(r[key]).toLowerCase()
      if (names.has(id)) continue
      const n = label(r)
      names.set(id, n ? n : '')
    }
  })
  return names
}

/** A driver report has no name; "Driver report <id>" reads "Driver report". */
function dropEmptyNames(text: string, names: Map<string, string>): string {
  return text.replace(new RegExp(` ${UUID_RX.source}`, 'gi'), (m) => {
    const n = names.get(m.trim().toLowerCase())
    return n === '' ? '' : m
  })
}

/** Rows with `field` rewritten for reading. */
export async function readableLogs<T extends Record<string, any>>(rows: T[], field: 'description' | 'message'): Promise<T[]> {
  if (!rows.length) return rows
  const names = await namesForIds(rows.map((r) => r[field]))
  return rows.map((r) => (typeof r[field] === 'string'
    ? { ...r, [field]: tidyLogText(dropEmptyNames(r[field], names), names) }
    : r))
}
