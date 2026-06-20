import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'

/** Effectively permanent ban (~100 years). Supabase requires a duration string. */
const BAN_DURATION = '876000h'

export type BanManagedUserRole =
  | 'admin'
  | 'client'
  | 'driver'
  | 'vendor'
  | 'accountant'
  | 'general_manager'
  | 'fleet_admin'
  | 'operations_admin'
  | 'it_admin'

export async function deactivateUserWithBan(
  userId: string,
  role: BanManagedUserRole,
  logAction: string,
  entityLabel: string,
  actorId?: string | null,
  ip?: string | null,
): Promise<{ user_id: string; status: string }> {
  const { data: existing, error: selErr } = await supabase
    .from('users')
    .select('user_id, status')
    .eq('user_id', userId)
    .eq('role', role)
    .neq('status', 'archived')
    .maybeSingle()

  if (selErr) throw selErr
  if (!existing) throw new Error(`${entityLabel} not found`)
  if (existing.status === 'deactivated') throw new Error(`${entityLabel} is already deactivated`)

  const { data, error } = await supabase
    .from('users')
    .update({ status: 'deactivated' })
    .eq('user_id', userId)
    .eq('role', role)
    .neq('status', 'archived')
    .select('user_id, status')
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`${entityLabel} not found or could not be deactivated`)

  const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: BAN_DURATION,
  })
  if (authError) console.error(`Auth ban failed for ${userId}: ${authError.message}`)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      logAction,
    description: `${entityLabel} ${userId} deactivated`,

  })

  return data as { user_id: string; status: string }
}

export async function activateUserWithUnban(
  userId: string,
  role: BanManagedUserRole,
  logAction: string,
  entityLabel: string,
  actorId?: string | null,
  ip?: string | null,
): Promise<{ user_id: string; status: string }> {
  const { data: existing, error: selErr } = await supabase
    .from('users')
    .select('user_id, status')
    .eq('user_id', userId)
    .eq('role', role)
    .neq('status', 'archived')
    .maybeSingle()

  if (selErr) throw selErr
  if (!existing) throw new Error(`${entityLabel} not found`)
  if (existing.status === 'active') throw new Error(`${entityLabel} is already active`)

  const { data, error } = await supabase
    .from('users')
    .update({ status: 'active' })
    .eq('user_id', userId)
    .eq('role', role)
    .neq('status', 'archived')
    .select('user_id, status')
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`${entityLabel} not found or could not be activated`)

  const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: 'none',
  })
  if (authError) console.error(`Auth unban failed for ${userId}: ${authError.message}`)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      logAction,
    description: `${entityLabel} ${userId} reactivated`,

  })

  return data as { user_id: string; status: string }
}
