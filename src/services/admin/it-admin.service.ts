import { supabase } from '../../lib/supabase.js'
import * as ITAdminModel from '../../models/admin/it-admin.model.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import { CreateITAdminInput, TransitionITAdminInput, UpdateITAdminInput } from '../../types/it-admin.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'
import { revokeAllUserSessions } from '../../models/auth/auth.model.js'
import { invalidateUserPermissions } from '../../middlewares/moduleAccess.middleware.js'
import * as ResetModel from '../../models/auth/password-reset.model.js'

/** Matches deactivateUserWithBan — a ban long enough to be permanent in practice. */
const BAN_DURATION = '876000h'

/** An error the controller can turn into a specific status code. */
function coded(message: string, code: string): Error {
  const err = new Error(message)
  ;(err as any).code = code
  return err
}

/**
 * Refuse to leave the system with no active IT Admin.
 *
 * This is not bureaucratic tidiness. Every staff password reset routes to the
 * 'it_admin' queue, a Company Admin is refused on those rows by
 * assertOwnsRequest(), and recipient lookups filter on status = 'active' — so
 * with nobody active, staff resets become invisible AND unactionable, with only a
 * console.error to show for it.
 *
 * The transition flow is the sanctioned exception: it takes the last active IT
 * Admin out of service only while putting a replacement in, inside one
 * transaction.
 */
async function assertNotLastActive(userId: string): Promise<void> {
  const others = await ITAdminModel.countOtherActive(userId)
  if (others === 0) {
    throw coded(
      'This is the only active IT Admin. Use the transition flow to hand the role ' +
      'to a successor — removing them outright would leave every staff password ' +
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
      'You cannot deactivate or remove your own IT Admin account.',
      'IT_ADMIN_SELF_ACTION',
    )
  }
}

export async function getAllITAdmins(actorId?: string | null) {
  return ITAdminModel.findAll(actorId ?? undefined)
}

export async function getITAdminById(userId: string) {
  const itAdmin = await ITAdminModel.findById(userId)
  if (!itAdmin) throw new Error('IT Admin not found')
  return itAdmin
}

export async function createITAdmin(
  input:    CreateITAdminInput,
  actorId?: string | null,
  ip?:      string | null,
) {
  // Checked before touching Supabase Auth. `users_one_active_it_admin` is the
  // race-proof backstop, but letting it be the only guard would mean creating an
  // Auth identity and then rolling it back on a 23505 — this way the common case
  // is a clean refusal that never creates anything.
  const active = await ITAdminModel.findActive()
  if (active.length > 0) {
    throw coded(
      `An active IT Admin already exists (${active[0].email}). The system allows ` +
      'only one. Use the transition flow to replace them.',
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
      const msg = err instanceof Error ? err.message : String(err)
      console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
      console.error(`WELCOME_EMAIL_FAILED for it_admin ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'it_admin_created',
      description: `IT Admin ${input.email} created (user: ${userId})`,
    })

    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
    console.error('IT Admin creation failed, rolling back auth user...', msg)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user with ID:', userId)
    throw new Error(`IT Admin creation failed: ${msg}`)
  }
}

export async function updateITAdmin(
  userId:   string,
  input:    UpdateITAdminInput,
  actorId?: string | null,
  ip?:      string | null,
) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: input.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await ITAdminModel.update(userId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'it_admin_updated',
    description: `IT Admin ${userId} updated`,
  })

  return result
}

export async function deleteITAdmin(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  assertNotSelf(userId, actorId)
  await assertNotLastActive(userId)

  const result = await ITAdminModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'it_admin_deleted',
    description: `IT Admin ${userId} deleted`,
  })

  return result
}

export async function deactivateITAdmin(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  assertNotSelf(userId, actorId)
  await assertNotLastActive(userId)

  const result = await deactivateUserWithBan(userId, 'it_admin', 'it_admin_deactivated', 'IT Admin', actorId, ip)

  // deactivateUserWithBan flips the status and bans the Supabase Auth identity,
  // but this app issues its own JWTs and `authenticate` only checks the session
  // row — never users.status. Without this, a deactivated IT Admin keeps a working
  // access token until it expires (15 minutes by default).
  await revokeAllUserSessions(userId).catch((err) =>
    console.error(`[it-admin] session revoke failed for deactivated ${userId}`, err),
  )
  invalidateUserPermissions(userId)

  return result
}

export async function activateITAdmin(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  return activateUserWithUnban(userId, 'it_admin', 'it_admin_activated', 'IT Admin', actorId, ip)
}

/**
 * Hand the IT Admin role from the incumbent to a successor.
 *
 * The whole point is that the two halves — retiring the outgoing account and
 * installing the incoming one — commit together. Done as two API calls there is
 * a window with no active IT Admin, and in that window every staff password
 * reset is invisible (recipient lookups filter on status='active') and
 * unactionable (a Company Admin is refused by assertOwnsRequest). The
 * transition_it_admin() RPC is what makes the window not exist.
 *
 * The Supabase Auth identity is the one step that cannot be inside that
 * transaction, so it is created first and deleted again if the RPC raises — the
 * same compensation createITAdmin uses.
 */
export async function transitionITAdmin(
  input:    TransitionITAdminInput,
  actorId?: string | null,
  ip?:      string | null,
) {
  const active = await ITAdminModel.findActive()
  if (active.length === 0) {
    throw coded(
      'There is no active IT Admin to transition from. Create one instead.',
      'NO_ACTIVE_IT_ADMIN',
    )
  }
  // Impossible once users_one_active_it_admin exists, but a pre-migration
  // database could hold duplicates and picking one arbitrarily would silently
  // leave the other in place.
  if (active.length > 1) {
    throw coded(
      `Found ${active.length} active IT Admins. Resolve that before transitioning.`,
      'MULTIPLE_ACTIVE_IT_ADMINS',
    )
  }

  const outgoing = active[0]
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
  })

  if (rpcError) {
    // The RPC rolled back, so the outgoing account is untouched and the only
    // thing left over is the Auth identity we made a moment ago.
    console.error('IT Admin transition failed, rolling back auth user...', rpcError.message)
    const ok = await deleteAuthUserSafely(incomingId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user with ID:', incomingId)
    throw new Error(`IT Admin transition failed: ${rpcError.message}`)
  }

  // Past this point the handover is durable. Everything below is best effort and
  // logged individually — none of it may throw, because failing now would report
  // a completed transition as an error.

  // The one that matters most: sign-in and refresh are already gated on
  // status='active', but `authenticate` checks only the session row, so without
  // this the outgoing IT Admin keeps a live access token for up to 15 minutes.
  await revokeAllUserSessions(outgoing.user_id).catch((err) =>
    console.error(`[it-admin] session revoke failed for outgoing ${outgoing.user_id}`, err),
  )
  invalidateUserPermissions(outgoing.user_id)

  await supabase.auth.admin
    .updateUserById(outgoing.user_id, { ban_duration: BAN_DURATION })
    .then(({ error }) => {
      if (error) console.error(`[it-admin] auth ban failed for outgoing ${outgoing.user_id}`, error.message)
    })
    .catch((err) => console.error(`[it-admin] auth ban threw for outgoing ${outgoing.user_id}`, err))

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
    const msg = err instanceof Error ? err.message : String(err)
    // Not fatal, and not a dead end: the incoming IT Admin can get in through the
    // self-service OTP reset at /auth/it-admin/forgot-password without anyone's help.
    console.error(`WELCOME_EMAIL_FAILED for incoming it_admin ${incomingId}:`, msg)
  })

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'it_admin_transitioned',
    description:
      `IT Admin role transitioned from ${outgoing.email} (${outgoing.user_id}, now deactivated) ` +
      `to ${input.email} (${incomingId}). Reason: ${input.reason}`,
  })

  return {
    outgoing: { user_id: outgoing.user_id, email: outgoing.email, status: 'deactivated' },
    incoming: created,
  }
}