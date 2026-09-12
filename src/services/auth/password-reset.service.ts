import crypto from 'crypto'
import * as AuthModel from '../../models/auth/auth.model.js'
import * as ResetModel from '../../models/auth/password-reset.model.js'
import { hashToken } from './auth.service.js'
import { supabase } from '../../lib/supabase.js'
import { buildResetUrl, sendPasswordResetEmail } from '../../lib/brevo-mailer.js'
import { logEvent } from '../../lib/log-event.js'
import {
  notifyResetCompleted,
  notifyResetRequested,
} from '../notification/password-reset-notify.service.js'
import {
  PasswordResetQueueItem,
  PasswordResetRequestRow,
  ResetHandlerGroup,
  ResetRequestStatus,
} from '../../types/password-reset.types.js'

// How long a sent link stays usable. Short enough that an intercepted or
// forwarded email goes stale, long enough that a driver can read it at the end
// of a run.
const TOKEN_TTL_MINS = 60

// Re-notifying the admin queue is throttled so a user tapping "forgot password"
// repeatedly cannot bury the bell. The request itself is always reused.
const RENOTIFY_COOLDOWN_MINS = 15

// Statuses a reset must never resurrect. A deactivated or archived account was
// switched off deliberately; that decision outranks a forgotten password.
const UNRESETTABLE_STATUSES = ['deactivated', 'archived', 'inactive']

/**
 * The whole routing rule, in one place.
 *
 * Drivers and clients are the Company Admin's people; everyone with a desk is the
 * IT Admin's. Exported because both the request path (which queue to file into)
 * and the send path (who is allowed to act) must agree, and the only way to
 * guarantee that is to ask the same function.
 */
export function handlerGroupFor(role: string): ResetHandlerGroup {
  return role === 'driver' || role === 'client' ? 'company_admin' : 'it_admin'
}

/** The admin role that staffs a group — the mirror of handlerGroupFor. */
function groupForActorRole(actorRole: string): ResetHandlerGroup | null {
  if (actorRole === 'admin')    return 'company_admin'
  if (actorRole === 'it_admin') return 'it_admin'
  return null
}

export interface ResetActor {
  user_id: string
  role:    string
}

/**
 * Assert this actor owns this request's queue.
 *
 * The routes can only gate with `authorize('admin','it_admin')`, which cannot
 * express "admin handles drivers and clients, it_admin handles staff" — so the
 * strict split is enforced here, where both roles have already been let through.
 */
function assertOwnsRequest(request: PasswordResetRequestRow, actor: ResetActor): void {
  const actorGroup = groupForActorRole(actor.role)
  if (!actorGroup || actorGroup !== request.handler_group) {
    const err = new Error(
      request.handler_group === 'company_admin'
        ? 'Driver and client password resets are handled by the Company Admin.'
        : 'Staff password resets are handled by the IT Admin.',
    )
    ;(err as any).code = 'RESET_WRONG_HANDLER'
    throw err
  }
}

/** Show enough of an address to recognise it, not enough to harvest it. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '•••'
  const head = local.slice(0, 2)
  return `${head}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`
}


/**
 * Raise a reset request for whoever owns this email.
 *
 * Always resolves, and the controller always answers the same way, so this
 * endpoint cannot be used to find out which addresses have accounts. The silent
 * paths are still written to login_history, the same way requestOtp does it, so
 * the attempts are visible to us even though they are invisible to the caller.
 */
export async function requestPasswordReset(input: {
  email: string
  ip?:   string | null
}): Promise<void> {
  const email = input.email.trim().toLowerCase()

  try {
    const user = await AuthModel.findUserByEmail(email)

    if (!user) {
      await AuthModel.createLoginHistory({
        email,
        attempt_status: 'failed_inactive',
        failure_reason: 'Password reset requested for unknown email',
      })
      return
    }

    if (UNRESETTABLE_STATUSES.includes(user.status)) {
      await AuthModel.createLoginHistory({
        user_id: user.user_id,
        email,
        attempt_status: 'failed_inactive',
        failure_reason: `Password reset requested on ${user.status} account`,
      })
      return
    }

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || null

    // Retire any link that already ran out, so an abandoned one does not hold the
    // single open slot and leave this user unable to ask again.
    await ResetModel.expireStale().catch((err) =>
      console.error('[password-reset] expireStale failed', err),
    )

    const existing = await ResetModel.findOpenByUser(user.user_id)
    if (existing) {
      // Reuse the open request rather than queueing a duplicate. Re-notify only
      // if the queue has not heard about it recently — a locked-out user tapping
      // the button five times should not cost the admin five notifications.
      const lastNotified = existing.last_notified_at
        ? new Date(existing.last_notified_at).getTime()
        : 0
      const quietFor = Date.now() - lastNotified
      if (quietFor >= RENOTIFY_COOLDOWN_MINS * 60 * 1000) {
        await ResetModel.touchNotifiedAt(existing.request_id)
        await notifyResetRequested(existing, fullName)
      }
      return
    }

    const request = await ResetModel.create({
      user_id:        user.user_id,
      email,
      requested_role: user.role,
      handler_group:  handlerGroupFor(user.role),
      requested_ip:   input.ip ?? null,
    })

    logEvent({
      user_id:     user.user_id,
      log_type:    'user_activity',
      action:      'password_reset_requested',
      description: `Password reset requested for ${email} (${user.role}) -> ${request.handler_group} queue`,
    })

    await notifyResetRequested(request, fullName)
  } catch (err) {
    // Swallowed on purpose: a failure here must not turn into a different
    // response than the success path, or the difference becomes the oracle.
    console.error('[password-reset] requestPasswordReset failed for', email, err)
  }
}

/** The queue for whichever group this admin staffs. */
export async function listRequestsForActor(
  actor:    ResetActor,
  statuses: ResetRequestStatus[] = ['pending', 'sent'],
): Promise<PasswordResetQueueItem[]> {
  const group = groupForActorRole(actor.role)
  if (!group) return []

  await ResetModel.expireStale().catch((err) =>
    console.error('[password-reset] expireStale failed', err),
  )

  return ResetModel.listForGroup(group, statuses)
}

/**
 * Issue the one-time link and email it.
 *
 * The plaintext token is returned to nobody and logged nowhere — only its hash is
 * stored, and the only copy in existence is the one in the email.
 */
export async function sendResetLink(
  requestId: string,
  actor:     ResetActor,
): Promise<PasswordResetRequestRow> {
  const request = await ResetModel.findById(requestId)
  if (!request) throw new Error('Reset request not found')

  assertOwnsRequest(request, actor)

  if (request.status !== 'pending') {
    throw new Error(
      request.status === 'sent'
        ? 'A reset link has already been sent for this request.'
        : `This request is already ${request.status}.`,
    )
  }

  const token     = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINS * 60 * 1000)

  // Build the link BEFORE burning the request. If the app base URL is not
  // configured this throws, and it has to throw while the row is still 'pending'
  // — otherwise the admin is told "link sent", the request is closed, and the
  // locked-out user waits on an email pointing nowhere.
  const resetUrl = buildResetUrl(token)

  const sent = await ResetModel.markSent(requestId, hashToken(token), expiresAt, actor.user_id)
  // Lost a race with another admin pressing Send on the same row.
  if (!sent) throw new Error('A reset link has already been sent for this request.')

  const user = await AuthModel.findUserById(request.user_id)

  try {
    await sendPasswordResetEmail({
      to:               request.email,
      firstName:        user?.first_name ?? null,
      resetUrl,
      expiresInMinutes: TOKEN_TTL_MINS,
    })
  } catch (err) {
    // The row says 'sent' but no email left the building. Put it back so the
    // admin can try again instead of staring at a request they cannot re-send.
    await ResetModel.cancel(requestId).catch(() => {})
    throw err
  }

  logEvent({
    user_id:     actor.user_id,
    log_type:    'user_activity',
    action:      'password_reset_link_sent',
    description: `Reset link sent to ${request.email} (${request.requested_role}), request ${requestId}`,
  })

  return sent
}

/**
 * Check a link before showing the form, so an expired or spent token says so
 * instead of letting someone type a password into a dead page.
 */
export async function verifyResetToken(
  token: string,
): Promise<{ valid: boolean; email?: string; expires_at?: string }> {
  const request = await ResetModel.findLiveByTokenHash(hashToken(token))
  if (!request) return { valid: false }

  return {
    valid:      true,
    email:      maskEmail(request.email),
    expires_at: request.token_expires_at ?? undefined,
  }
}

/**
 * Spend the token: set the new password, lift the lockout, and cut every
 * existing session.
 *
 * The order matters. The password changes first, because that is the step that
 * can fail on a weak-password rejection from Supabase, and failing it must leave
 * the token usable. The lockout clears next — this, not the admin's click, is
 * what actually lets the user back in. Sessions go last: any session still alive
 * on this account belongs to whoever caused the lockout.
 */
export async function completeReset(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(token)
  const request   = await ResetModel.findLiveByTokenHash(tokenHash)

  if (!request) {
    const err = new Error('This reset link is invalid or has expired. Please request a new one.')
    ;(err as any).code = 'RESET_TOKEN_INVALID'
    throw err
  }

  const { error: authError } = await supabase.auth.admin.updateUserById(request.user_id, {
    password: newPassword,
  })
  if (authError) throw new Error(`Failed to update password: ${authError.message}`)

  const cleared = await ResetModel.clearLockout(request.user_id)
  if (!cleared) {
    // The account was deactivated or archived between the send and the reset.
    // The password is already changed, which is harmless, but the account stays
    // off and the link is burned.
    await ResetModel.markCompleted(request.request_id).catch(() => {})
    const err = new Error('This account is no longer active. Please contact your administrator.')
    ;(err as any).code = 'RESET_ACCOUNT_INACTIVE'
    throw err
  }

  await AuthModel.revokeAllUserSessions(request.user_id)

  const completed = await ResetModel.markCompleted(request.request_id)
  // Another request for the same token already completed — the password change
  // above was idempotent, so there is nothing to undo.
  if (!completed) return

  logEvent({
    user_id:     request.user_id,
    log_type:    'user_activity',
    action:      'password_reset_completed',
    description: `Password reset completed for ${request.email}, request ${request.request_id}`,
  })

  const user = await AuthModel.findUserById(request.user_id)
  const fullName = user
    ? [user.first_name, user.last_name].filter(Boolean).join(' ') || null
    : null

  await notifyResetCompleted(completed, fullName)
}

/** Dismiss a request without sending anything. */
export async function cancelRequest(
  requestId: string,
  actor:     ResetActor,
): Promise<PasswordResetRequestRow> {
  const request = await ResetModel.findById(requestId)
  if (!request) throw new Error('Reset request not found')

  assertOwnsRequest(request, actor)

  const cancelled = await ResetModel.cancel(requestId)
  if (!cancelled) throw new Error(`This request is already ${request.status}.`)

  logEvent({
    user_id:     actor.user_id,
    log_type:    'user_activity',
    action:      'password_reset_cancelled',
    description: `Reset request ${requestId} for ${request.email} cancelled`,
  })

  return cancelled
}
