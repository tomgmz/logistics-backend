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
      // Spelled out rather than left to the column default: this is the mediated
      // path, and the OTP path below is the only other one.
      delivery_method: 'link',
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
 * Retire OTP requests whose code ran out and was never used.
 *
 * expireStale() above only looks at 'sent' rows, because a mediated request is not
 * time-limited until a link exists. An OTP request is time-limited from the moment
 * it is raised, and an abandoned one has to be cleared for a different reason: it
 * is still 'pending', so it occupies the one-open-request-per-user slot, and it is
 * invisible to the admin queue by design. Left behind, it would block this user's
 * next reset of either kind.
 */
export async function expireStaleOtps(): Promise<number> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({ status: 'expired', otp_hash: null, updated_at: new Date().toISOString() })
    .eq('status', 'pending')
    .eq('delivery_method', 'otp')
    .lt('otp_expires_at', new Date().toISOString())
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
    // Only the mediated requests. An IT Admin's OTP reset is self-served and has
    // no admin step, so listing it would put a Send button next to a request that
    // is already being handled by the person reading the queue.
    .eq('delivery_method', 'link')
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

// ---------------------------------------------------------------------------
// The IT Admin's self-service OTP path.
//
// Same table, same completion endpoint: verifying the code turns the row into an
// ordinary 'sent' request holding a one-time token, and /auth/reset-password
// finishes it exactly as it finishes a mediated one.
// ---------------------------------------------------------------------------

/** The live OTP request for this user, if one is outstanding. */
export async function findOpenOtpByUser(userId: string): Promise<PasswordResetRequestRow | null> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .select('*')
    .eq('user_id', userId)
    .eq('delivery_method', 'otp')
    .eq('status', 'pending')
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

export async function createOtpRequest(params: {
  user_id:        string
  email:          string
  requested_role: string
  otp_hash:       string
  otp_expires_at: Date
  requested_ip?:  string | null
}): Promise<PasswordResetRequestRow> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('password_reset_requests')
    .insert({
      user_id:         params.user_id,
      email:           params.email,
      requested_role:  params.requested_role,
      // The IT Admin's own group, so a completed self-service reset still shows
      // up where that queue lives - an IT Admin resetting their own password is
      // exactly the event you want a record of.
      handler_group:   'it_admin',
      delivery_method: 'otp',
      requested_ip:    params.requested_ip ?? null,
      otp_hash:        params.otp_hash,
      otp_expires_at:  params.otp_expires_at.toISOString(),
      otp_attempts:    0,
      otp_sent_at:     nowIso,
    })
    .select()
    .single()

  if (error) throw error
  return data as PasswordResetRequestRow
}

/**
 * Put a fresh code on an outstanding request.
 *
 * A resend replaces the code rather than opening a second request: the row is the
 * one open slot this user gets, and minting a new hash orphans the old code, so
 * only the newest email works.
 */
export async function refreshOtp(
  requestId: string,
  otpHash:   string,
  expiresAt: Date,
): Promise<PasswordResetRequestRow | null> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({
      otp_hash:       otpHash,
      otp_expires_at: expiresAt.toISOString(),
      // The attempt budget belongs to the code, not to the request - otherwise a
      // resend would hand back nothing to whoever mistyped the first one twice.
      otp_attempts:   0,
      otp_sent_at:    nowIso,
      updated_at:     nowIso,
    })
    .eq('request_id', requestId)
    .eq('status', 'pending')
    .eq('delivery_method', 'otp')
    .select()
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}

/**
 * Count one wrong code, and return the new total.
 *
 * Guarded on the count we read, so two submissions racing cannot both write the
 * same number and hand out a free attempt. The loser re-reads rather than
 * retrying: the only thing it needs is an honest total.
 */
export async function bumpOtpAttempts(requestId: string, seen: number): Promise<number> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({ otp_attempts: seen + 1, updated_at: new Date().toISOString() })
    .eq('request_id', requestId)
    .eq('otp_attempts', seen)
    .select('otp_attempts')
    .maybeSingle()

  if (error) throw error
  if (data) return (data as { otp_attempts: number }).otp_attempts

  const current = await findById(requestId)
  return current?.otp_attempts ?? seen + 1
}

/**
 * Spend the code and mint the reset token.
 *
 * The OTP fields are cleared in the same write that stores the token hash, so a
 * code can never be replayed against a request that has already moved on. Guarded
 * on `status = 'pending'` and on the hash still being there, which is what makes
 * two submissions of the same code race safely: one wins, the other matches no
 * row and is told to start again.
 */
export async function markOtpVerified(
  requestId:      string,
  tokenHash:      string,
  tokenExpiresAt: Date,
  selfUserId:     string,
): Promise<PasswordResetRequestRow | null> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('password_reset_requests')
    .update({
      status:           'sent',
      token_hash:       tokenHash,
      token_expires_at: tokenExpiresAt.toISOString(),
      // There is no approver on this path. Recording the IT Admin as their own
      // sender keeps the audit trail honest, rather than leaving a null that
      // reads like a link nobody sent.
      sent_by:          selfUserId,
      sent_at:          nowIso,
      otp_hash:         null,
      otp_expires_at:   null,
      updated_at:       nowIso,
    })
    .eq('request_id', requestId)
    .eq('status', 'pending')
    .eq('delivery_method', 'otp')
    .not('otp_hash', 'is', null)
    .select()
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as PasswordResetRequestRow | null
}
