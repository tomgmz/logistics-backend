import { supabase } from '../../lib/supabase.js'
import {
  PasswordResetQueueItem,
  PasswordResetRequestRow,
  ResetHandlerGroup,
  ResetRequestStatus,
} from '../../types/password-reset.types.js'

const OPEN_STATUSES: ResetRequestStatus[] = ['pending', 'sent']

// Statuses an admin may still issue a link for. 'expired' is included so a link
// that timed out unused can be re-sent from the queue, rather than the admin
// staring at a dead row while the locked-out user is told to start again.
const SENDABLE_STATUSES: ResetRequestStatus[] = ['pending', 'expired']

// An admin can dismiss anything not already finished.
const CANCELLABLE_STATUSES: ResetRequestStatus[] = ['pending', 'sent', 'expired']

/** The one open request for a user, if any — enforced unique by the DB index. */
export async function findOpenByUser(userId: string): Promise<PasswordResetRequestRow | null> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .select('*')
    .eq('user_id', userId)
    .in('status', OPEN_STATUSES)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

export async function create(params: {
  user_id:        string
  email:          string
  requested_role: string
  handler_group:  ResetHandlerGroup
  requested_ip?:  string | null
}): Promise<PasswordResetRequestRow> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .insert({
      user_id:        params.user_id,
      email:          params.email,
      requested_role: params.requested_role,
      handler_group:  params.handler_group,
      requested_ip:   params.requested_ip ?? null,
      last_notified_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error
  return data as PasswordResetRequestRow
}

export async function findById(requestId: string): Promise<PasswordResetRequestRow | null> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .select('*')
    .eq('request_id', requestId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

export async function touchNotifiedAt(requestId: string): Promise<void> {
  const { error } = await supabase
    .from('password_reset_requests')
    .update({ last_notified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('request_id', requestId)

  if (error) throw error
}

/**
 * Move a pending request to 'sent' with its token.
 *
 * Guarded on the sendable statuses so two admins clicking Send at the same moment
 * cannot both issue a link — the second update matches no row and comes back
 * null. Re-sending an expired request mints a fresh token, which also orphans
 * the old one, since only the stored hash can be matched.
 */
export async function markSent(
  requestId:      string,
  tokenHash:      string,
  tokenExpiresAt: Date,
  sentBy:         string,
): Promise<PasswordResetRequestRow | null> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({
      status:           'sent',
      token_hash:       tokenHash,
      token_expires_at: tokenExpiresAt.toISOString(),
      sent_by:          sentBy,
      sent_at:          nowIso,
      updated_at:       nowIso,
    })
    .eq('request_id', requestId)
    .in('status', SENDABLE_STATUSES)
    .select()
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

/**
 * Undo a markSent that could not be delivered.
 *
 * Puts the row back to 'pending' and drops the token, so the admin sees an
 * actionable request again. Cancelling instead would close it and force the
 * locked-out user to start over, which is the opposite of what a failed send
 * should cost them.
 */
export async function revertToPending(requestId: string): Promise<void> {
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from('password_reset_requests')
    .update({
      status:           'pending',
      token_hash:       null,
      token_expires_at: null,
      sent_by:          null,
      sent_at:          null,
      updated_at:       nowIso,
    })
    .eq('request_id', requestId)
    .eq('status', 'sent')

  if (error) throw error
}

/** A live (sent, unexpired) request for this token hash. */
export async function findLiveByTokenHash(tokenHash: string): Promise<PasswordResetRequestRow | null> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .select('*')
    .eq('token_hash', tokenHash)
    .eq('status', 'sent')
    .gt('token_expires_at', new Date().toISOString())
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

/**
 * Burn the token and close the request.
 *
 * Guarded on `status = 'sent'` so a replayed link cannot complete twice, and the
 * token_hash is cleared so a stored hash is not left lying around after use.
 */
export async function markCompleted(requestId: string): Promise<PasswordResetRequestRow | null> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({
      status:       'completed',
      token_hash:   null,
      completed_at: nowIso,
      updated_at:   nowIso,
    })
    .eq('request_id', requestId)
    .eq('status', 'sent')
    .select()
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

export async function cancel(requestId: string): Promise<PasswordResetRequestRow | null> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({ status: 'cancelled', token_hash: null, updated_at: nowIso })
    .eq('request_id', requestId)
    .in('status', CANCELLABLE_STATUSES)
    .select()
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

/**
 * Retire sent-but-unused links whose token has run out, so they stop occupying
 * the one-open-request-per-user slot and the queue reads honestly.
 */
export async function expireStale(): Promise<number> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({ status: 'expired', token_hash: null, updated_at: new Date().toISOString() })
    .eq('status', 'sent')
    .lt('token_expires_at', new Date().toISOString())
    .select('request_id')

  if (error) throw error
  return (data ?? []).length
}

/**
 * The queue for one admin group. Joins the requester's name so the table can show
 * a person rather than a UUID.
 */
export async function listForGroup(
  group:    ResetHandlerGroup,
  statuses: ResetRequestStatus[],
  limit = 100,
): Promise<PasswordResetQueueItem[]> {
  // The FK must be named explicitly. This table points at `users` twice — once via
  // `user_id` (the requester) and once via `sent_by` (the admin who sent the link)
  // — so a bare `users!inner(...)` embed is ambiguous and PostgREST rejects it
  // outright with PGRST201. The requester is the one whose name the queue shows.
  const { data, error } = await supabase
    .from('password_reset_requests')
    .select('*, users!password_reset_requests_user_id_fkey!inner(first_name, last_name)')
    .eq('handler_group', group)
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  // Flatten the embedded users row so the API shape stays flat for the table.
  return (data ?? []).map((row: any) => {
    const { users, ...rest } = row
    return {
      ...rest,
      first_name: users?.first_name ?? null,
      last_name:  users?.last_name  ?? null,
    } as PasswordResetQueueItem
  })
}

/**
 * Clear every lockout counter — completing the reset is what actually lets the
 * user back in, so all four fields go at once. Leaving `lockup_count` behind is
 * the bug that made the old activate path re-lock a user on their next typo.
 *
 * Scoped to `active` / `permanently_locked` on purpose. If the account was
 * deactivated or archived in the window between the request and the reset, this
 * matches no row and the caller is told — a reset link must never be a way to
 * resurrect an account an admin deliberately switched off.
 */
export async function clearLockout(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .update({
      status:                'active',
      locked_until:          null,
      failed_login_attempts: 0,
      lockup_count:          0,
      must_change_password:  false,
      updated_at:            new Date().toISOString(),
    })
    .eq('user_id', userId)
    .in('status', ['active', 'permanently_locked'])
    .select('user_id')
    .maybeSingle()

  if (error) throw error
  return !!data
}
