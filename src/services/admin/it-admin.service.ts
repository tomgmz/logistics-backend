import { supabase } from '../../lib/supabase.js'
import * as ITAdminModel from '../../models/admin/it-admin.model.js'
import { activateUserWithUnban, banArchivedAuthUser, deactivateUserWithBan } from './user-auth-status.service.js'
import * as WebauthnModel from '../../models/auth/webauthn.model.js'
import { ITAdminHandover, ITAdminSuccessorInput, StartHandoverInput, UpdateITAdminInput } from '../../types/it-admin.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail, TEMP_PASSWORD_TTL_DAYS } from '../../lib/brevo-mailer.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'
import { invalidateUserPermissions } from '../../middlewares/moduleAccess.middleware.js'
import * as ResetModel from '../../models/auth/password-reset.model.js'
import { assertPhoneAvailable } from '../../lib/phone-unique.js'
import { errorMessage } from '../../lib/error-message.js'

/** An error the controller can turn into a specific status code. */
function coded(message: string, code: string): Error {
  const err = new Error(message)
  ;(err as any).code = code
  return err
}

/** The render target: how long a handover is expected to take (not a deadline). */
export const RENDER_DAYS = 30

/**
 * Refuse to take the seat holder (the active IT Admin not serving a render
 * period) out of service.
 *
 * This is not bureaucratic tidiness. Every staff password reset routes to the
 * 'it_admin' queue, a Company Admin is refused on those rows by
 * assertOwnsRequest(), and recipient lookups filter on status = 'active' — so
 * with nobody active, staff resets become invisible AND unactionable, with only a
 * console.error to show for it.
 *
 * The seat only changes hands through the handover. A predecessor still serving
 * their render period may be deactivated early: the seat holder covers the queue.
 */
async function assertNotSeatHolder(userId: string): Promise<void> {
  const seat = await ITAdminModel.findSeatHolders()
  if (seat.some((s) => s.user_id === userId)) {
    throw coded(
      'This is the current IT Administrator. The role changes hands only when they hand it ' +
      'over to a successor — removing them outright would leave every staff password ' +
      'reset with nobody able to action it.',
      'LAST_IT_ADMIN',
    )
  }
}

/**
 * Refuse to let someone switch off their own IT Admin account.
 *
 * The routes are gated with authorize('admin','it_admin'), so an IT Admin reaches
 * these endpoints — and findAll() hides the caller from their own list, so they
 * cannot even see that they are the last one before doing it.
 */
function assertNotSelf(userId: string, actorId?: string | null): void {
  if (actorId && actorId === userId) {
    throw coded(
      'You cannot deactivate or remove your own IT Administrator account.',
      'IT_ADMIN_SELF_ACTION',
    )
  }
}

export async function getAllITAdmins(actorId?: string | null) {
  return ITAdminModel.findAll(actorId ?? undefined)
}

export async function getITAdminById(userId: string) {
  const itAdmin = await ITAdminModel.findById(userId)
  if (!itAdmin) throw new Error('IT Administrator not found')
  return itAdmin
}

export async function updateITAdmin(
  userId:   string,
  input:    UpdateITAdminInput,
  actorId?: string | null,
) {
  await assertPhoneAvailable(input.phone, userId)

  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: input.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await ITAdminModel.update(userId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_updated',
    description: `IT Administrator ${userId} updated`,
  })

  return result
}

export async function deleteITAdmin(
  userId:   string,
  actorId?: string | null,
) {
  assertNotSelf(userId, actorId)
  await assertNotSeatHolder(userId)

  const result = await ITAdminModel.remove(userId)
  await banArchivedAuthUser(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_archived',
    description: `IT Administrator ${userId} archived`,
  })

  return result
}

export async function deactivateITAdmin(
  userId:   string,
  actorId?: string | null,
) {
  assertNotSelf(userId, actorId)
  await assertNotSeatHolder(userId)

  // deactivateUserWithBan also signs them out everywhere.
  const result = await deactivateUserWithBan(userId, 'it_admin', 'it_admin_deactivated', 'IT Administrator', actorId)
  invalidateUserPermissions(userId)

  return result
}

export async function activateITAdmin(
  userId:   string,
  actorId?: string | null,
) {
  return activateUserWithUnban(userId, 'it_admin', 'it_admin_activated', 'IT Administrator', actorId)
}

/* ── Handover ──────────────────────────────────────────────────────────────
 *
 * Two steps since 2026-10-25 (migration 20261025010000_it_admin_handover_two_step):
 *
 *   1. The IT Admin STARTS the handover on themselves: their 30-day render begins
 *      (users.render_ends_at). The successor may be named now or later.
 *   2. They ADD the successor whenever one is found: an it_admin account with an
 *      emailed temporary password (7 days).
 *   3. The successor CONFIRMS by setting their own password (first sign-in, or
 *      the IT Admin emailed-code reset). completeHandoverOnConfirm ends the
 *      render at once and archives the outgoing account.
 *
 * The 30 days is a target only. Without a confirmed successor the outgoing IT
 * Admin stays active past it, because there must never be zero IT Admins: every
 * password reset routes to the it_admin queue.
 */

/** The open handover run by `actorId`, or a coded refusal. */
async function openHandoverOf(actorId: string) {
  const handover = await ITAdminModel.findOpenHandover()
  if (!handover || handover.outgoing_id !== actorId) {
    throw coded('There is no handover in progress on your account.', 'NO_OPEN_HANDOVER')
  }
  return handover
}

/** Turns an RPC's RAISE into the same coded refusal the controller maps. */
function rpcRefusal(message: string): Error | null {
  for (const [token, text] of [
    ['NOT_SEAT_HOLDER',   'Only the current IT Administrator can start a handover.'],
    ['HANDOVER_OPEN',     'A handover is already in progress.'],
    ['NO_OPEN_HANDOVER',  'There is no handover in progress on your account.'],
    ['SUCCESSOR_PENDING', 'A replacement is already waiting to confirm. Replace them first.'],
  ] as const) {
    if (message.includes(token)) return coded(text, token)
  }
  return null
}

/**
 * Where the caller stands: holding the role (no handover), or rendering, with
 * the successor (if any) and whether they have confirmed yet.
 */
export async function getHandoverStatus(actorId: string) {
  const handover = await ITAdminModel.findOpenHandover()
  const mine     = handover && handover.outgoing_id === actorId ? handover : null

  let successor: {
    user_id: string; email: string; first_name: string | null; last_name: string | null
    temp_password_expires_at: string | null
  } | null = null
  if (mine?.successor_id) {
    const { data } = await supabase
      .from('users')
      .select('user_id, email, first_name, last_name, temp_password_expires_at')
      .eq('user_id', mine.successor_id)
      .maybeSingle()
    successor = data ?? null
  }

  return {
    render_days: RENDER_DAYS,
    handover: mine && {
      handover_id:   mine.handover_id,
      reason:        mine.reason,
      started_at:    mine.started_at,
      render_due_at: mine.render_due_at,
      overdue:       new Date(mine.render_due_at).getTime() < Date.now(),
      successor,
    },
  }
}

/**
 * Step 1: start the render. With `successor` given, also step 2 in the same
 * call (the replacement is already known).
 */
export async function startHandover(input: StartHandoverInput, actorId: string) {
  const { data, error } = await supabase.rpc('start_it_admin_handover', {
    p_outgoing_id: actorId,
    p_reason:      input.reason,
    p_render_days: RENDER_DAYS,
  })
  if (error) throw rpcRefusal(error.message) ?? new Error(`Could not start the handover: ${error.message}`)

  const handover = data as ITAdminHandover
  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_handover_started',
    description: `IT Administrator handover started; render target ${handover.render_due_at}. Reason: ${input.reason}`,
  })

  // A failed successor here leaves a started handover with none added yet,
  // which the panel shows with "Add your replacement": nothing to undo.
  const successor = input.successor ? await addSuccessor(input.successor, actorId) : null
  return { handover, successor }
}

/** Step 2: the successor's account, created with an emailed temporary password. */
export async function addSuccessor(input: ITAdminSuccessorInput, actorId: string) {
  const handover = await openHandoverOf(actorId)
  if (handover.successor_id) throw rpcRefusal('SUCCESSOR_PENDING')!
  await assertPhoneAvailable(input.phone)

  const password = generateSecurePassword()
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password,
    email_confirm: true,
    user_metadata: { role: 'it_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)
  const incomingId = authData.user.id

  const { data: created, error: rpcError } = await supabase.rpc('add_it_admin_successor', {
    p_outgoing_id: actorId,
    p_incoming_id: incomingId,
    p_email:       input.email,
    p_first_name:  input.first_name,
    p_last_name:   input.last_name,
    p_middle_name: input.middle_name ?? null,
    p_suffix:      input.suffix ?? null,
    p_phone:       input.phone ?? null,
  })
  if (rpcError) {
    // The RPC rolled back; only the Auth identity made a moment ago is left.
    const ok = await deleteAuthUserSafely(incomingId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user with ID:', incomingId)
    throw rpcRefusal(rpcError.message) ?? new Error(`Could not add the replacement: ${rpcError.message}`)
  }

  sendWelcomeEmail({ to: input.email, firstName: input.first_name ?? null, role: 'it_admin', password })
    .catch((err: unknown) => {
      // Not a dead end: "Resend sign-in email" on the panel issues a new one.
      console.error(`WELCOME_EMAIL_FAILED for incoming it_admin ${incomingId}:`, errorMessage(err))
    })

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_successor_added',
    description: `Replacement IT Administrator ${input.email} (${incomingId}) added; the handover ends when they set their own password`,
  })

  return created
}

/** A new temporary password for a successor who lost or let the first one expire. */
export async function resendSuccessorSignIn(actorId: string) {
  const handover = await openHandoverOf(actorId)
  if (!handover.successor_id) throw coded('No replacement has been added yet.', 'NO_SUCCESSOR')

  const { data: successor, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, must_change_password')
    .eq('user_id', handover.successor_id)
    .maybeSingle()
  if (error) throw error
  if (!successor) throw coded('The replacement account was not found.', 'NO_SUCCESSOR')
  if (!successor.must_change_password) {
    throw coded('The replacement has already set their own password.', 'SUCCESSOR_CONFIRMED')
  }

  const password = generateSecurePassword()
  const { error: authError } = await supabase.auth.admin.updateUserById(successor.user_id, { password })
  if (authError) throw new Error(`Could not issue a new password: ${authError.message}`)
  // A fresh 7 days for the new temporary password (TEMP_PASSWORD_TTL_DAYS). The
  // expiry trigger only stamps it when must_change_password turns on; while it
  // stays on, a value written here is kept.
  const expires = new Date(Date.now() + TEMP_PASSWORD_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { error: stampErr } = await supabase.from('users')
    .update({ temp_password_expires_at: expires }).eq('user_id', successor.user_id)
  if (stampErr) throw stampErr

  await sendWelcomeEmail({ to: successor.email, firstName: successor.first_name ?? null, role: 'it_admin', password })

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_successor_reissued',
    description: `New sign-in email sent to replacement IT Administrator ${successor.email}`,
  })
}

/** Archive an unconfirmed successor so a different one can be added. */
export async function replaceSuccessor(actorId: string) {
  const handover = await openHandoverOf(actorId)
  if (!handover.successor_id) throw coded('No replacement has been added yet.', 'NO_SUCCESSOR')
  await archiveUnconfirmedSuccessor(handover.successor_id, actorId)
  await ITAdminModel.updateHandover(handover.handover_id, { successor_id: null, successor_added_at: null })
}

/** Stop the handover before anyone confirmed: the caller keeps the role. */
export async function cancelHandover(actorId: string) {
  const handover = await openHandoverOf(actorId)
  if (handover.successor_id) await archiveUnconfirmedSuccessor(handover.successor_id, actorId)

  await ITAdminModel.updateHandover(handover.handover_id, { cancelled_at: new Date().toISOString() })
  const { error } = await supabase.from('users').update({ render_ends_at: null }).eq('user_id', actorId)
  if (error) throw error

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_handover_cancelled',
    description: 'IT Administrator handover cancelled; the role stays with the current IT Administrator',
  })
}

async function archiveUnconfirmedSuccessor(successorId: string, actorId: string) {
  const { data } = await supabase.from('users').select('must_change_password').eq('user_id', successorId).maybeSingle()
  if (data && !data.must_change_password) {
    throw coded('The replacement has already set their own password.', 'SUCCESSOR_CONFIRMED')
  }
  await archiveAccount(successorId)
  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_archived',
    description: `Unconfirmed replacement IT Administrator ${successorId} archived`,
  })
}

/** Archive: status archived, signed out everywhere, login banned, passkeys ended. */
async function archiveAccount(userId: string) {
  await ITAdminModel.remove(userId)
  await banArchivedAuthUser(userId)
  await WebauthnModel.revokeAllForUser(userId, null, 'Account archived').catch((err) =>
    console.error('[it-admin] passkey revoke failed', userId, err),
  )
  invalidateUserPermissions(userId)
}

/**
 * Step 3, called when an IT Admin sets their own password (first sign-in or the
 * emailed-code reset). If they are the pending successor of the open handover,
 * the render ends now and the outgoing account is archived. A no-op otherwise.
 * Never throws: the password change itself has already succeeded.
 */
export async function completeHandoverOnConfirm(userId: string): Promise<void> {
  try {
    const { data: outgoingId, error } = await supabase.rpc('complete_it_admin_handover', { p_successor_id: userId })
    if (error) throw error
    if (!outgoingId) return

    await archiveAccount(outgoingId as string)

    // The new IT Admin inherits an honest reset queue.
    await ResetModel.expireStale().catch(() => {})
    await ResetModel.expireStaleOtps().catch(() => {})

    logEvent({
      user_id:     userId,
      log_type:    'user_management',
      action:      'it_admin_handover_completed',
      description: `IT Administrator handover completed: ${userId} set their password and holds the role; the previous IT Administrator ${outgoingId} was archived`,
    })
  } catch (err) {
    console.error('[it-admin] completing the handover failed; the render scheduler retries', userId, err)
  }
}

/**
 * Safety net for the render scheduler: finish any handover whose successor has
 * already set their password but was not closed (e.g. the server stopped mid-way).
 * Returns how many it closed. Nothing ends on a timer any more.
 */
export async function completeMissedHandovers(): Promise<number> {
  const missed = await ITAdminModel.findConfirmedButOpen()
  for (const h of missed) await completeHandoverOnConfirm(h.successor_id)
  return missed.length
}
