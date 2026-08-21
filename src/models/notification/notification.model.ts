import { supabase } from '../../lib/supabase.js'
import { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'

// --- writes -----------------------------------------------------------------

export async function insertMany(rows: CreateNotificationInput[]): Promise<NotificationRow[]> {
  if (rows.length === 0) return []
  const payload = rows.map((r) => ({
    user_id:    r.user_id,
    type:       r.type,
    title:      r.title,
    body:       r.body,
    booking_id: r.booking_id ?? null,
    data:       r.data ?? {},
  }))
  const { data, error } = await supabase
    .from('notifications')
    .insert(payload)
    .select()
  if (error) throw error
  return (data ?? []) as NotificationRow[]
}

export async function markRead(userId: string, notificationId: string): Promise<NotificationRow | null> {
  const { data, error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('notification_id', notificationId)
    .eq('user_id', userId)
    .is('read_at', null)
    .select()
    .maybeSingle()
  if (error) throw error
  return (data ?? null) as NotificationRow | null
}

export async function markAllRead(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null)
    .select('notification_id')
  if (error) throw error
  return (data ?? []).length
}

// --- reads ------------------------------------------------------------------

export async function listForUser(
  userId: string,
  opts: { limit: number; before?: string | null },
): Promise<NotificationRow[]> {
  let query = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(opts.limit)

  if (opts.before) query = query.lt('created_at', opts.before)

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as NotificationRow[]
}

export async function countUnread(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('notification_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null)
  if (error) throw error
  return count ?? 0
}

// --- recipient resolution ---------------------------------------------------

// True if at least one active user holds any of the given roles. Used to decide
// whether a workflow stage is staffed (e.g. is there a GM yet?).
export async function hasActiveUsersWithRoles(roles: string[]): Promise<boolean> {
  if (roles.length === 0) return false
  const { count, error } = await supabase
    .from('users')
    .select('user_id', { count: 'exact', head: true })
    .in('role', roles)
    .eq('status', 'active')
  if (error) throw error
  return (count ?? 0) > 0
}

// Anyone who may act on the GM approval stage: the general manager(s) plus any
// user the IT admin has appointed as a GM proxy (an accountant standing in while
// the GM is unavailable). Used both for recipient resolution and for the
// staffing check that decides whether the stage can be auto-cleared.
export async function resolveGmApprovers(): Promise<{ user_id: string; role: string }[]> {
  const [gms, proxies] = await Promise.all([
    supabase.from('users').select('user_id, role').eq('role', 'general_manager').eq('status', 'active'),
    supabase.from('users').select('user_id, role').eq('is_gm_proxy', true).eq('status', 'active'),
  ])
  if (gms.error)     throw gms.error
  if (proxies.error) throw proxies.error

  const byId = new Map<string, { user_id: string; role: string }>()
  for (const row of [...(gms.data ?? []), ...(proxies.data ?? [])] as { user_id: string; role: string }[]) {
    byId.set(row.user_id, row)
  }
  return [...byId.values()]
}

// Whether a given user is allowed to act on the GM approval stage — the GM
// themselves, an admin, or an appointed proxy.
export async function isGmApprover(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .select('role, status, is_gm_proxy')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data || data.status !== 'active') return false
  return data.role === 'general_manager' || data.role === 'admin' || data.is_gm_proxy === true
}

// Active users whose role is in the given set. `admin` is always included by the
// caller as the RBAC fallback ("the system can work if there is no GM").
export async function resolveUserIdsByRoles(roles: string[]): Promise<string[]> {
  if (roles.length === 0) return []
  const { data, error } = await supabase
    .from('users')
    .select('user_id')
    .in('role', roles)
    .eq('status', 'active')
  if (error) throw error
  return (data ?? []).map((r: { user_id: string }) => r.user_id)
}

// Same as resolveUserIdsByRoles but keeps each recipient's role, so the caller
// can build a per-recipient deep-link into that role's own module page (an admin
// recipient must land on /admin/..., not the responsible role's route).
export async function resolveRecipientsByRoles(
  roles: string[],
): Promise<{ user_id: string; role: string }[]> {
  if (roles.length === 0) return []
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role')
    .in('role', roles)
    .eq('status', 'active')
  if (error) throw error
  return (data ?? []) as { user_id: string; role: string }[]
}

// The user account behind a booking's client_id (bookings.client_id -> clients.client_id).
export async function resolveClientUserId(clientId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('clients')
    .select('user_id')
    .eq('client_id', clientId)
    .maybeSingle()
  if (error) throw error
  return (data as { user_id: string } | null)?.user_id ?? null
}

// The user accounts of every driver assigned to a booking
// (driver_assignments.driver_id -> drivers.user_id).
export async function resolveDriverUserIds(bookingId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('driver_assignments')
    .select('drivers ( user_id )')
    .eq('booking_id', bookingId)
  if (error) throw error
  return (data ?? [])
    .map((row: any) => row.drivers?.user_id)
    .filter((id: string | undefined): id is string => Boolean(id))
}
