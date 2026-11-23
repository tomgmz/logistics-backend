import crypto from 'crypto'
import * as AuthModel from '../../models/auth/auth.model.js'
import * as ResetModel from '../../models/auth/password-reset.model.js'
import { hashToken, passwordMatches, samePasswordError } from './auth.service.js'
import { completeHandoverOnConfirm } from '../admin/it-admin.service.js'
import { supabase } from '../../lib/supabase.js'
import {
  buildResetUrl,
  formatManilaTimestamp,
  sendPasswordChangedEmail,
  sendPasswordResetAlertEmail,
  sendPasswordResetEmail,
} from '../../lib/mailer.js'
import { logEvent } from '../../lib/log-event.js'
import {
  closeReplacedRequests,
  closeResetRequestsFor,
  closeStaleResetRequests,
} from './reset-request-cleanup.js'
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

// How long a sent link stays usable (user 2026-11-08: 5 minutes). An intercepted
// or forwarded email goes stale almost at once; someone who misses the window
// asks again and the admin resends from the queue.
const TOKEN_TTL_MINS = 5

// Re-notifying the admin queue is throttled so a user tapping "forgot password"
// repeatedly cannot bury the bell. The request itself is always reused.
const RENOTIFY_COOLDOWN_MINS = 15

// Self-service links (IT Administrator, Company Administrator, General Manager):
// one email per minute per account, so the button cannot be used to bury
// someone in mail. Inside the minute nothing is sent and nothing is said; the
// link from a moment ago is still in the inbox.
const SELF_SERVICE_RESEND_COOLDOWN_SECS = 60

// Statuses a reset must never resurrect. A deactivated or archived account was
// switched off deliberately; that decision outranks a forgotten password.
const UNRESETTABLE_STATUSES = ['deactivated', 'archived', 'inactive']

/**
 * The whole routing rule, in one place.
 *
 * Since 2026-10-24 the IT Administrator handles every reset: staff, drivers and
 * clients alike. The 'company_admin' group survives only on old rows (the
 * migration moved the open ones over). Exported because both the request path
 * (which queue to file into) and the send path (who is allowed to act) must
 * agree, and the only way to guarantee that is to ask the same function.
 */
export function handlerGroupFor(_role: string): ResetHandlerGroup {
  return 'it_admin'
}

/** The admin role that staffs a group — the mirror of handlerGroupFor. */
function groupForActorRole(actorRole: string): ResetHandlerGroup | null {
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
 * The routes gate with `authorize('admin','it_admin')`; only the IT Admin owns a
 * queue now, so a Company Admin who gets through the route is refused here.
 */
function assertOwnsRequest(request: PasswordResetRequestRow, actor: ResetActor): void {
  const actorGroup = groupForActorRole(actor.role)
  if (!actorGroup || actorGroup !== request.handler_group) {
    const err = new Error('Password resets are handled by the IT Administrator.')
    ;(err as any).code = 'RESET_WRONG_HANDLER'
    throw err
  }
}

/**
 * The moment of the change, in the timezone the reader lives in.
 *
 * Manila because that is where the business and its people are — a security
 * notice whose whole job is "was this you, at this time?" is useless if the
 * reader has to convert from UTC to answer it. Matches the Asia/Manila the
 * transaction-history queries already report in.
 */
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

    // The three senior office roles get their link straight away, no approval.
    if (canSelfServeReset(user.role)) {
      await sendSelfServiceLink(user, email)
      return
    }

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || null

    // Retire any link that already ran out, so an abandoned one does not hold the
    // single open slot and leave this user unable to ask again.
    await ResetModel.expireStale().catch((err) =>
      console.error('[password-reset] expireStale failed', err),
    )
    // An abandoned OTP request is 'pending' forever and invisible to the queue, so
    // it has to be cleared here too or it would hold this user's one open slot
    // against a request no admin can even see. IT Admins only, in practice.
    await ResetModel.expireStaleOtps().catch((err) =>
      console.error('[password-reset] expireStaleOtps failed', err),
    )

    const existing = await ResetModel.findOpenByUser(user.user_id)

    // A live OTP request is not something an admin can act on. Asking for the
    // mediated route is a decision to wait for a colleague instead, so the
    // self-service attempt is closed and this becomes an ordinary queue request.
    if (existing && existing.delivery_method === 'otp') {
      await ResetModel.cancel(existing.request_id).catch((err) =>
        console.error('[password-reset] could not supersede OTP request', err),
      )
    } else if (existing) {
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

    // Asking again after a link expired: the new request replaces the old one,
    // so the queue never shows the same person twice.
    await closeReplacedRequests(user.user_id)

    const request = await ResetModel.create({
      user_id:        user.user_id,
      email,
      requested_role: user.role,
      handler_group:  handlerGroupFor(user.role),
    })

    logEvent({
      user_id:     user.user_id,
      log_type:    'auth',
      action:      'password_reset_requested',
      description: `Password reset requested for ${email} (${user.role}) -> ${request.handler_group} queue`,
    })

    await notifyResetRequested(request, fullName)
  } catch (err) {
    // Swallowed on purpose: a failure here must not turn into a different
    // response than the success path, or the difference becomes the oracle.
    //
    // 23505 on the one-open-request index is the expected outcome of two clicks
    // landing together — the row the loser wanted already exists, which is the
    // result it wanted anyway. Logging it as an error taught people to ignore
    // real reset errors, so it is noted quietly instead.
    if ((err as { code?: string })?.code === '23505') {
      console.info('[password-reset] concurrent request for', email, '— existing row kept')
      return
    }
    console.error('[password-reset] requestPasswordReset failed for', email, err)
  }
}

/** The queue for whichever group this admin staffs. */
export async function listRequestsForActor(
  actor:    ResetActor,
  // 'expired' is in the default view because it is still actionable — someone is
  // locked out with a link that timed out, and hiding the row would leave the
  // admin unaware anyone was waiting.
  statuses: ResetRequestStatus[] = ['pending', 'sent', 'expired'],
): Promise<PasswordResetQueueItem[]> {
  const group = groupForActorRole(actor.role)
  if (!group) return []

  await ResetModel.expireStale().catch((err) =>
    console.error('[password-reset] expireStale failed', err),
  )
  // Expired requests nobody acted on for 7 days leave the queue.
  await closeStaleResetRequests()

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

  // Belt and braces: the queue already filters these out, so reaching one here
  // means a request id was supplied by hand. An OTP request has no link to send.
  if (request.delivery_method !== 'link') {
    throw new Error('This request is being reset by verification code, not by link.')
  }

  // 'expired' is sendable: the previous link timed out unused, and re-issuing is
  // exactly what the admin is there to do. Minting a fresh token also orphans the
  // old one, since only the stored hash can ever be matched.
  if (request.status !== 'pending' && request.status !== 'expired') {
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
  const resetUrl = buildResetUrl(token, request.requested_role)

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
    // The row says 'sent' but no email left the building. Put it back to pending
    // so the admin can press Send again. This used to cancel the request, which
    // closed it outright and made the locked-out user start over because our
    // mail provider had a bad minute.
    await ResetModel.revertToPending(requestId).catch(() => {})
    throw err
  }

  logEvent({
    user_id:     actor.user_id,
    log_type:    'auth',
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
export async function completeReset(
  token:       string,
  newPassword: string,
  /**
   * Roughly where the reset came from ("San Pablo City, Philippines"), for the
   * confirmation emails ONLY. The controller works it out from the request, so
   * the IP itself never reaches this service (see lib/ip-location.ts).
   *
   * It is handed to the mailer and then goes out of scope. Nothing on this path
   * writes it down -- not the audit event below, not the request row, not a log
   * line.
   */
  location?:   string | null,
): Promise<void> {
  const tokenHash = hashToken(token)
  const request   = await ResetModel.findLiveByTokenHash(tokenHash)

  if (!request) {
    const err = new Error('This reset link is invalid or has expired. Please request a new one.')
    ;(err as any).code = 'RESET_TOKEN_INVALID'
    throw err
  }

  // Checked against the account's current email, not the request.email
  // snapshot, since that is the address Supabase signs in with. Nothing is
  // spent on a refusal: the link stays live for a different password.
  const account = await AuthModel.findUserById(request.user_id)
  if (account && await passwordMatches(account.email, newPassword)) throw samePasswordError()

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
    const err = new Error('This account is no longer active. Please contact your Administrator.')
    ;(err as any).code = 'RESET_ACCOUNT_INACTIVE'
    throw err
  }

  await AuthModel.revokeAllUserSessions(request.user_id, 'password_reset')

  const completed = await ResetModel.markCompleted(request.request_id)
  // Another request for the same token already completed — the password change
  // above was idempotent, so there is nothing to undo.
  if (!completed) return

  // An IT Admin's own reset (the emailed-code path) also confirms a pending
  // handover: a replacement whose temporary password ran out lands here.
  if (request.requested_role === 'it_admin') await completeHandoverOnConfirm(request.user_id)

  // Any other unfinished request of theirs (an older expired one) is done with.
  void closeResetRequestsFor(request.user_id, 'password_changed')

  logEvent({
    user_id:     request.user_id,
    log_type:    'auth',
    action:      'password_reset_completed',
    description: `Password reset completed for ${request.email}, request ${request.request_id}`,
  })

  const user = await AuthModel.findUserById(request.user_id)
  const fullName = user
    ? [user.first_name, user.last_name].filter(Boolean).join(' ') || null
    : null

  // Tell the account holder, not just the admin queue.
  //
  // Addressed to the account's CURRENT email rather than request.email, which is
  // a snapshot taken when the reset was raised — if the address changed in
  // between, the snapshot is exactly the wrong place to send a security notice.
  //
  // Fire-and-forget on purpose. The password is already changed, the sessions are
  // already cut and the request is already closed; letting a mail failure reject
  // this call would tell someone their reset had failed when it plainly had not,
  // and they would try again with a token that is now spent.
  sendPasswordChangedEmail({
    to:        user?.email ?? request.email,
    firstName: user?.first_name ?? null,
    changedAt: formatManilaTimestamp(completed.completed_at),
    location:  location ?? null,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[password-reset] confirmation email failed for ${request.email}:`, msg)
  })

  // Company copy, for every role. Fire-and-forget for the same reason as above.
  sendPasswordResetAlertEmail({
    userEmail: user?.email ?? request.email,
    fullName,
    role:      user?.role ?? null,
    changedAt: formatManilaTimestamp(completed.completed_at),
    location:  location ?? null,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[password-reset] company alert email failed for ${request.email}:`, msg)
  })

  await notifyResetCompleted(completed, fullName)
}

// ---------------------------------------------------------------------------
// Self-service reset links (2026-11-23, user decision).
//
// The IT Administrator, Company Administrator and General Manager do not wait
// for anyone: asking for a reset emails them the same one-time link (5 minutes,
// works once) that the IT Administrator sends everyone else after approving it.
// Industry pattern: Auth0 / Okta "email me a reset link", Microsoft Entra and
// Google Workspace self-service reset turned on for chosen groups. It replaced
// the emailed 6-digit code (2026-11-16 .. 11-23): a link cannot be guessed, and a
// refresh of the reset page keeps working until the link is used or expires.
//
// The request still goes on the queue row, marked sent by the person
// themselves, so the IT Administrator's Password Reset list keeps a record; the
// IT Administrator is told when the reset completes (notifyResetCompleted).
// ---------------------------------------------------------------------------

export const SELF_SERVICE_RESET_ROLES: readonly string[] = ['it_admin', 'admin', 'general_manager']

/** Who gets a reset link straight away instead of waiting for approval. */
export function canSelfServeReset(role: string): boolean {
  return SELF_SERVICE_RESET_ROLES.includes(role)
}

/**
 * Email a self-service link. Called from requestPasswordReset only, so it
 * inherits that function's rule: whatever happens here, the caller answers the
 * same way, and errors are swallowed there.
 */
async function sendSelfServiceLink(
  user:  { user_id: string; role: string; first_name?: string | null },
  email: string,
): Promise<void> {
  await ResetModel.expireStale().catch((err) =>
    console.error('[password-reset] expireStale failed', err),
  )
  // Old code requests (before 2026-11-23) must not hold the one open slot.
  await ResetModel.expireStaleOtps().catch((err) =>
    console.error('[password-reset] expireStaleOtps failed', err),
  )

  const existing = await ResetModel.findOpenByUser(user.user_id)

  if (existing && existing.status === 'sent' && existing.sent_at) {
    const sinceLast = Date.now() - new Date(existing.sent_at).getTime()
    if (sinceLast < SELF_SERVICE_RESEND_COOLDOWN_SECS * 1000) return
  }

  // Anything still open is replaced: a queue request (no need to wait any more),
  // an earlier self-service link (only the newest link works), an old code.
  if (existing) {
    await ResetModel.cancel(existing.request_id).catch((err) =>
      console.error('[password-reset] could not supersede open request', err),
    )
  }
  await closeReplacedRequests(user.user_id)

  const request = await ResetModel.create({
    user_id:        user.user_id,
    email,
    requested_role: user.role,
    handler_group:  handlerGroupFor(user.role),
  })

  const token     = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINS * 60 * 1000)
  // Built before the row is marked sent: a missing app address throws here, and
  // the request is closed below rather than left saying "sent".
  let resetUrl: string
  try {
    resetUrl = buildResetUrl(token, user.role)
  } catch (err) {
    await ResetModel.cancel(request.request_id).catch(() => {})
    throw err
  }

  // sent_by = the person themselves: the queue shows it was self-service.
  const sent = await ResetModel.markSent(request.request_id, hashToken(token), expiresAt, user.user_id)
  if (!sent) return

  try {
    await sendPasswordResetEmail({
      to:               email,
      firstName:        user.first_name ?? null,
      resetUrl,
      expiresInMinutes: TOKEN_TTL_MINS,
      selfService:      true,
    })
  } catch (err) {
    // No email went out, so the row is a dead end; close it. The person can ask
    // again (or the IT Administrator can help) once mail works.
    await ResetModel.cancel(request.request_id).catch(() => {})
    throw err
  }

  logEvent({
    user_id:     user.user_id,
    log_type:    'auth',
    action:      'password_reset_link_self_service',
    description: `Self-service reset link sent to ${email} (${user.role}), request ${request.request_id}`,
  })
}

/**
 * Reject (pending) or dismiss (expired) a request. A request whose link is live
 * ('sent') can't be withdrawn: the person may be opening it right now. An
 * expired one can, so a stale row never has to sit in the queue (2026-11-18).
 */
export async function cancelRequest(
  requestId: string,
  actor:     ResetActor,
): Promise<PasswordResetRequestRow> {
  const request = await ResetModel.findById(requestId)
  if (!request) throw new Error('Reset request not found')

  assertOwnsRequest(request, actor)

  if (request.status === 'sent') {
    throw new Error('A reset link was just sent for this request and is still valid, so it can no longer be rejected.')
  }

  const cancelled = await ResetModel.cancel(requestId, ['pending', 'expired'])
  if (!cancelled) {
    const now = await ResetModel.findById(requestId)
    throw new Error(
      now?.status === 'sent'
        ? 'A reset link was just sent for this request and is still valid, so it can no longer be rejected.'
        : `This request is already ${now?.status ?? request.status}.`,
    )
  }

  logEvent({
    user_id:     actor.user_id,
    log_type:    'auth',
    action:      'password_reset_cancelled',
    description: `Reset request ${requestId} for ${request.email} cancelled`,
  })

  return cancelled
}
