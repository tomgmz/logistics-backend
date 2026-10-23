import { supabase } from '../../lib/supabase.js'
import * as ITAdminModel from '../../models/admin/it-admin.model.js'
import { activateUserWithUnban, banArchivedAuthUser, deactivateUserWithBan } from './user-auth-status.service.js'
import { CreateITAdminInput, TransitionITAdminInput, UpdateITAdminInput } from '../../types/it-admin.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'
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

/** How long an outgoing IT Admin stays active after handing the role over. */
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

export async function createITAdmin(
  input:    CreateITAdminInput,
  actorId?: string | null,
) {
  await assertPhoneAvailable(input.phone)

  // Checked before touching Supabase Auth. `users_one_active_it_admin` is the
  // race-proof backstop, but letting it be the only guard would mean creating an
  // Auth identity and then rolling it back on a 23505 — this way the common case
  // is a clean refusal that never creates anything.
  const active = await ITAdminModel.findSeatHolders()
  if (active.length > 0) {
    throw coded(
      `An active IT Administrator already exists (${active[0].email}). The system allows ` +
      'only one. They hand the role over to a successor from their own portal.',
      'IT_ADMIN_EXISTS',
    )
  }

  const password = generateSecurePassword()

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password,
    email_confirm: true,
    user_metadata: { role: 'it_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await ITAdminModel.create(userId, { ...input, created_by: actorId ?? input.created_by ?? undefined })

    sendWelcomeEmail({
      to:        input.email,
      firstName: input.first_name ?? null,
      role:      'it_admin',
      password,
    }).catch((err: unknown) => {
      const msg = errorMessage(err)
      console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
      console.error(`WELCOME_EMAIL_FAILED for it_admin ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_management',
      action:      'it_admin_created',
      description: `IT Administrator ${input.email} created (user: ${userId})`,
    })

    return result
  } catch (err: unknown) {
    const msg = errorMessage(err)
    console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
    console.error('IT Admin creation failed, rolling back auth user...', msg)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user with ID:', userId)
    throw new Error(`IT Administrator creation failed: ${msg}`)
  }
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
    action:      'it_admin_deleted',
    description: `IT Administrator ${userId} deleted`,
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

/**
 * Where the caller stands in a handover: their own render end (null while they
 * hold the seat) and every other active IT Admin, so the portal can show either
 * "Hand over the role" or "Your account is deactivated on …".
 */
export async function getHandoverStatus(actorId: string) {
  const active = await ITAdminModel.findActive()
  const me     = active.find((a) => a.user_id === actorId) ?? null
  return {
    render_days:    RENDER_DAYS,
    render_ends_at: me?.render_ends_at ?? null,
    others:         active.filter((a) => a.user_id !== actorId),
  }
}

/**
 * The IT Admin hands their role to a successor they create here.
 *
 * Run by the outgoing IT Admin on themselves. The successor's account is
 * created and becomes the seat holder at once; the outgoing account stays active
 * for a RENDER_DAYS render period (to hand over the work) and is then
 * deactivated by the it-admin-render scheduler.
 *
 * Both halves commit together in transition_it_admin(), so there is never a
 * moment without a seat holder — the staff password reset queue has no other
 * staff. The Supabase Auth identity is the one step that cannot be inside that
 * transaction, so it is created first and deleted again if the RPC raises — the
 * same compensation createITAdmin uses.
 */
export async function transitionITAdmin(
  input:    TransitionITAdminInput,
  actorId?: string | null,
) {
  await assertPhoneAvailable(input.phone)

  const seat     = await ITAdminModel.findSeatHolders()
  const outgoing = seat.find((s) => s.user_id === actorId)
  if (!outgoing) {
    throw coded(
      'Only the current IT Administrator can hand the role over, and only once.',
      'NOT_SEAT_HOLDER',
    )
  }

  const password = generateSecurePassword()

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password,
    email_confirm: true,
    user_metadata: { role: 'it_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const incomingId = authData.user.id

  const { data: created, error: rpcError } = await supabase.rpc('transition_it_admin', {
    p_outgoing_id: outgoing.user_id,
    p_incoming_id: incomingId,
    p_email:       input.email,
    p_first_name:  input.first_name,
    p_last_name:   input.last_name,
    p_middle_name: input.middle_name ?? null,
    p_suffix:      input.suffix ?? null,
    p_phone:       input.phone ?? null,
    p_created_by:  actorId ?? null,
    p_render_days: RENDER_DAYS,
  })

  if (rpcError) {
    // The RPC rolled back, so the outgoing account is untouched and the only
    // thing left over is the Auth identity we made a moment ago.
    console.error('IT Admin transition failed, rolling back auth user...', rpcError.message)
    const ok = await deleteAuthUserSafely(incomingId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user with ID:', incomingId)
    throw new Error(`IT Administrator transition failed: ${rpcError.message}`)
  }

  // Past this point the handover is durable. Everything below is best effort and
  // logged individually — none of it may throw, because failing now would report
  // a completed transition as an error. The outgoing IT Admin stays signed in:
  // the render period is theirs to work, and the scheduler ends it.
  const renderEndsAt = new Date(Date.now() + RENDER_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // These sweeps only ever run opportunistically inside a reset request, so a
  // handover — which changes who reads that queue — is a sensible moment to make
  // sure the incoming IT Admin inherits an honest one.
  await ResetModel.expireStale().catch((err) =>
    console.error('[it-admin] expireStale failed during transition', err),
  )
  await ResetModel.expireStaleOtps().catch((err) =>
    console.error('[it-admin] expireStaleOtps failed during transition', err),
  )

  sendWelcomeEmail({
    to:        input.email,
    firstName: input.first_name ?? null,
    role:      'it_admin',
    password,
  }).catch((err: unknown) => {
    const msg = errorMessage(err)
    // Not fatal, and not a dead end: the incoming IT Admin can get in through the
    // self-service OTP reset at /auth/it-admin/forgot-password without anyone's help.
    console.error(`WELCOME_EMAIL_FAILED for incoming it_admin ${incomingId}:`, msg)
  })

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_transitioned',
    description:
      `IT Administrator role handed over by ${outgoing.email} (${outgoing.user_id}) ` +
      `to ${input.email} (${incomingId}). The outgoing account renders for ${RENDER_DAYS} days ` +
      `and is deactivated after ${renderEndsAt}. Reason: ${input.reason}`,
  })

  return {
    outgoing: { user_id: outgoing.user_id, email: outgoing.email, status: 'active', render_ends_at: renderEndsAt },
    incoming: created,
  }
}

/**
 * End every render period that has run out: deactivate, sign out everywhere and
 * lock the login (deactivateUserWithBan does all three). Driven by the
 * it-admin-render scheduler; returns how many accounts it closed.
 */
export async function deactivateEndedRenders(now = new Date()): Promise<number> {
  const ended = await ITAdminModel.findRenderEnded(now)
  let closed = 0
  for (const u of ended) {
    await deactivateUserWithBan(u.user_id, 'it_admin', 'it_admin_render_ended', 'IT Administrator', null)
    invalidateUserPermissions(u.user_id)
    closed++
  }
  return closed
}