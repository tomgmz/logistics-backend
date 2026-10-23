import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { revokeAllUserSessions } from '../../models/auth/auth.model.js'

/** Effectively permanent ban (~100 years). Supabase requires a duration string. */
const BAN_DURATION = '876000h'

/**
 * Sign the user out everywhere, right now. The Supabase ban alone doesn't do
 * it: this app issues its own JWTs and `authenticate` checks only the session
 * row, never users.status, so without this an archived or deactivated account
 * keeps a working access token for up to 15 minutes. The revoke also
 * broadcasts session_revoked, so open browsers and phones sign out without
 * waiting for their next request. Logged, not thrown: the status change has
 * already landed by the time this runs.
 */
async function signOutEverywhere(userId: string) {
  await revokeAllUserSessions(userId, 'deactivated').catch((err) =>
    console.error(`[user-auth-status] session revoke failed for ${userId}`, err),
  )
}

export type BanManagedUserRole =
  | 'admin'
  | 'client'
  | 'driver'
  | 'general_manager'
  | 'fleet_manager'
  | 'operations_manager'
  | 'it_admin'

/**
 * Lock the Supabase Auth identity of an archived ("deleted") user.
 *
 * Delete is a soft archive: the profile row has to outlive the person because
 * audit_logs, messages, notifications and the rest point at it, and deleting
 * the auth user would cascade into it. Without the ban, though, the auth user
 * stays fully live — it can still mint and refresh tokens straight against
 * Supabase — so archiving must close it the same way deactivation does.
 * Throws: a delete that leaves a usable login behind is not a delete.
 */
export async function banArchivedAuthUser(userId: string) {
  await signOutEverywhere(userId)

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: BAN_DURATION,
  })
  if (error) throw new Error(`User archived, but locking their login failed: ${error.message}`)
}

/**
 * Bring an archived ("deleted") account back as active: the reverse of the
 * archive. Clears the lockout counters like a reactivation, and lifts the
 * Supabase ban. If the unban fails the status goes back to archived, so the
 * account is never shown as active while its login is still locked.
 *
 * Only one IT Administrator may be active (users_one_active_it_admin), so an
 * archived one cannot come back while another holds the seat; the seat holder
 * hands it over from their own portal instead.
 */
export async function restoreArchivedUser(
  userId: string,
  role: BanManagedUserRole,
  logAction: string,
  entityLabel: string,
  actorId?: string | null,
): Promise<{ user_id: string; status: string }> {
  const { data: existing, error: selErr } = await supabase
    .from('users')
    .select('user_id, status')
    .eq('user_id', userId)
    .eq('role', role)
    .maybeSingle()

  if (selErr) throw selErr
  if (!existing) throw new Error(`${entityLabel} not found`)
  if (existing.status !== 'archived') throw new Error(`${entityLabel} is not archived`)

  if (role === 'it_admin') {
    const { count, error: cntErr } = await supabase
      .from('users')
      .select('user_id', { count: 'exact', head: true })
      .eq('role', 'it_admin')
      .eq('status', 'active')
      .is('render_ends_at', null)
    if (cntErr) throw cntErr
    if ((count ?? 0) > 0) {
      throw new Error('Only one IT Administrator can be active. The current one hands the role over from their own portal.')
    }
  }

  const { data, error } = await supabase
    .from('users')
    .update({
      status:                'active',
      locked_until:          null,
      failed_login_attempts: 0,
      lockup_count:          0,
      ...(role === 'it_admin' ? { render_ends_at: null } : {}),
    })
    .eq('user_id', userId)
    .eq('role', role)
    .eq('status', 'archived')
    .select('user_id, status')
    .maybeSingle()

  // Another IT Administrator became active between the check and the update.
  if (error?.code === '23505' && role === 'it_admin') {
    throw new Error('Only one IT Administrator can be active. The current one hands the role over from their own portal.')
  }
  if (error) throw error
  if (!data) throw new Error(`${entityLabel} not found or could not be restored`)

  try {
    await unbanAuthUser(userId)
  } catch (err) {
    await supabase.from('users').update({ status: 'archived' }).eq('user_id', userId)
    throw new Error(`${entityLabel} could not be restored: unlocking their login failed (${(err as Error).message})`)
  }

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      logAction,
    description: `${entityLabel} ${userId} restored from the archive`,
  })

  return data as { user_id: string; status: string }
}

/** Undo banArchivedAuthUser when an archived account is brought back. */
export async function unbanAuthUser(userId: string) {
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: 'none',
  })
  if (error) throw error
}

export async function deactivateUserWithBan(
  userId: string,
  role: BanManagedUserRole,
  logAction: string,
  entityLabel: string,
  actorId?: string | null,
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

  await signOutEverywhere(userId)

  const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: BAN_DURATION,
  })
  if (authError) console.error(`Auth ban failed for ${userId}: ${authError.message}`)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
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

  // Reactivating has to clear the lockout counters too, not just the status.
  // This used to set `status` alone, which meant a user reactivated out of
  // `permanently_locked` came back still carrying lockup_count = 3 and was
  // permanently re-locked by their very next wrong password — the reactivation
  // looked like it worked and then silently didn't. The reset path clears the
  // same four fields, so both ways back in now behave identically.
  const { data, error } = await supabase
    .from('users')
    .update({
      status:                'active',
      locked_until:          null,
      failed_login_attempts: 0,
      lockup_count:          0,
      // A returning IT Admin comes back as the seat holder, not mid-render (a
      // stale end date would also let them slip past users_one_active_it_admin).
      ...(role === 'it_admin' ? { render_ends_at: null } : {}),
    })
    .eq('user_id', userId)
    .eq('role', role)
    .neq('status', 'archived')
    .select('user_id, status')
    .maybeSingle()

  if (error?.code === '23505' && role === 'it_admin') {
    throw new Error('Only one IT Administrator can be active. The current one hands the role over from their own portal.')
  }
  if (error) throw error
  if (!data) throw new Error(`${entityLabel} not found or could not be activated`)

  const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: 'none',
  })
  if (authError) console.error(`Auth unban failed for ${userId}: ${authError.message}`)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      logAction,
    description: `${entityLabel} ${userId} reactivated`,

  })

  return data as { user_id: string; status: string }
}
