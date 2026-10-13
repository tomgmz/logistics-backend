import { supabase } from '../../lib/supabase.js'

export interface PushSubscriptionRow {
  id:          string
  user_id:     string
  platform:    'web' | 'expo'
  token:       string
  keys:        { p256dh: string; auth: string } | null
  device_info: string | null
}

export async function upsertSubscription(input: {
  user_id:      string
  platform:     'web' | 'expo'
  token:        string
  keys?:        { p256dh: string; auth: string } | null
  device_info?: string | null
  /** The sign-in this device registered under; its notifications stop when that ends. */
  session_id?:  string | null
}): Promise<void> {
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id:      input.user_id,
        platform:     input.platform,
        token:        input.token,
        keys:         input.keys ?? null,
        device_info:  input.device_info ?? null,
        session_id:   input.session_id ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'token' }
    )
  if (error) throw error
}

export async function deleteByToken(token: string): Promise<void> {
  const { error } = await supabase.from('push_subscriptions').delete().eq('token', token)
  if (error) throw error
}

/**
 * The devices to notify for these users: only those whose registering sign-in
 * is still live. A device whose session was signed out, expired, replaced or
 * revoked is no longer theirs to notify — that is how a phone ended up showing
 * another driver's assignments — so it is skipped and its row deleted. A row
 * from before sessions were recorded is skipped too; the device re-registers
 * against its current session the next time the app opens.
 */
export async function getSubscriptionsForUsers(userIds: string[]): Promise<PushSubscriptionRow[]> {
  if (userIds.length === 0) return []
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, platform, token, keys, device_info, session_id, session:active_sessions(revoked_reason, refresh_expires_at)')
    .in('user_id', userIds)
  if (error) throw error

  type Row = PushSubscriptionRow & {
    session_id: string | null
    session: { revoked_reason: string | null; refresh_expires_at: string | null } | null
  }
  const now  = Date.now()
  const live: PushSubscriptionRow[] = []
  const dead: string[] = []
  for (const r of (data ?? []) as unknown as Row[]) {
    if (!r.session_id) continue
    const s = r.session
    const ended = !s || !!s.revoked_reason || !s.refresh_expires_at || new Date(s.refresh_expires_at).getTime() <= now
    if (ended) { dead.push(r.token); continue }
    const { session: _s, session_id: _id, ...sub } = r
    live.push(sub)
  }
  if (dead.length) void deleteTokens(dead).catch(() => {})
  return live
}

export async function getDisplayName(userId: string): Promise<string> {
  const { data } = await supabase
    .from('users')
    .select('first_name, last_name, email')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return 'New message'
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim()
  return name || data.email || 'New message'
}

export async function deleteTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return
  const { error } = await supabase.from('push_subscriptions').delete().in('token', tokens)
  if (error) throw error
}
