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

export async function getSubscriptionsForUsers(userIds: string[]): Promise<PushSubscriptionRow[]> {
  if (userIds.length === 0) return []
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, platform, token, keys, device_info')
    .in('user_id', userIds)
  if (error) throw error
  return (data ?? []) as PushSubscriptionRow[]
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
