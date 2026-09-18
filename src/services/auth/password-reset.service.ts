import crypto from 'crypto'
import bcrypt from 'bcrypt'
import * as AuthModel from '../../models/auth/auth.model.js'
import * as ResetModel from '../../models/auth/password-reset.model.js'
import { hashToken } from './auth.service.js'
import { supabase } from '../../lib/supabase.js'
import {
  buildResetUrl,
  sendPasswordResetEmail,
  sendPasswordResetOtpEmail,
} from '../../lib/brevo-mailer.js'
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

// --- The IT Admin's self-service OTP path -----------------------------------
//
// Short, because this code is the only thing standing between an emailed inbox
// and the account that administers every other account.
const OTP_TTL_MINS = 10

// One email per minute per account, so the button cannot be used to bury someone
// in mail or to keep minting fresh codes while guesses run against the old one.
const OTP_RESEND_COOLDOWN_SECS = 60

// Wrong codes allowed before the request is torn down and the IT Admin has to ask
// for a new one. Five guesses against a six-digit code is a 1-in-200,000 chance,
// and the teardown means the odds do not accumulate across attempts.
const MAX_OTP_ATTEMPTS = 5

// How long the token minted by a verified code stays good. Only long enough to
// choose a password on the page the verification just opened - unlike an emailed
// link, nobody has to find this one in an inbox later.
const OTP_RESET_TOKEN_TTL_MINS = 15

// bcrypt cost, matching auth.service so a reset code is stored exactly like a
// sign-in code.
const BCRYPT_ROUNDS = 12

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

    // An outside-vendor driver has no password to reset. Left open, this flow
    // would set one and hand back a way in that bypasses the passkey entirely —
    // the reset queue becoming a back door around the thing it sits beside.
    // Returns silently like every other refusal here, so the endpoint stays free
    // of an enumeration oracle.
    if (await AuthModel.isExternalDriver(user.user_id)) {
      await AuthModel.createLoginHistory({
        user_id: user.user_id,
        email,
        attempt_status: 'failed_inactive',
        failure_reason: 'Password reset requested for a passkey-only external driver',
      })
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

  // Checked again at completion, not just at request time. A token could have
  // been minted before the account became external, and this is the call that
  // actually writes a usable password.
  if (await AuthModel.isExternalDriver(request.user_id)) {
    await ResetModel.markCompleted(request.request_id).catch(() => {})
    const err = new Error('This account signs in with a passkey and has no password to reset.')
    ;(err as any).code = 'RESET_NOT_APPLICABLE'
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

// ---------------------------------------------------------------------------
// The IT Admin's self-service reset.
//
// Every other role waits for an admin to press Send. The IT Admin cannot: their
// queue is the one they staff, so a locked-out IT Admin raising a mediated
// request is waiting on themselves. They prove control of the registered mailbox
// with a six-digit code instead.
//
// What the code is NOT is the thing that changes the password. Verifying it mints
// the same opaque token an emailed link carries, and the same
// /auth/reset-password endpoint spends it - so there stays exactly one place that
// writes a new password, lifts the lockout and cuts every live session.
// ---------------------------------------------------------------------------

/** Who is allowed to reset themselves by code. Deliberately one role. */
export function canSelfResetByOtp(role: string): boolean {
  return role === 'it_admin'
}

function generateOtp(): string {
  // randomInt is rejection-sampled, so every code in the range is equally likely.
  // Taking a random uint32 modulo 1,000,000 is not: it biases the low codes, which
  // is a real edge when the whole secret is six digits.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/**
 * Email a reset code to an IT Admin.
 *
 * Resolves the same way for an unknown address, a non-IT-Admin account, a
 * deactivated one and a genuine send, because the controller answers from this
 * function's silence. Anything that sets those cases apart - a different message,
 * a different status, a slower failure - turns the endpoint into a way of asking
 * "is this address the IT Admin's?", which is the single most useful question an
 * attacker could ask of this system.
 */
export async function requestItAdminOtp(input: {
  email: string
  ip?:   string | null
}): Promise<void> {
  const email = input.email.trim().toLowerCase()

  try {
    const user = await AuthModel.findUserByEmail(email)

    if (!user || !canSelfResetByOtp(user.role)) {
      await AuthModel.createLoginHistory({
        user_id: user?.user_id,
        email,
        attempt_status: 'failed_inactive',
        failure_reason: user
          ? `Self-service reset code requested by non-IT-Admin account (${user.role})`
          : 'Self-service reset code requested for unknown email',
      })
      return
    }

    if (UNRESETTABLE_STATUSES.includes(user.status)) {
      await AuthModel.createLoginHistory({
        user_id: user.user_id,
        email,
        attempt_status: 'failed_inactive',
        failure_reason: `Self-service reset code requested on ${user.status} account`,
      })
      return
    }

    await ResetModel.expireStaleOtps().catch((err) =>
      console.error('[password-reset] expireStaleOtps failed', err),
    )

    const existing = await ResetModel.findOpenByUser(user.user_id)

    // An outstanding code is refreshed in place. Anything else open is superseded
    // and closed, because it holds the one open slot this user gets:
    //
    //   - a mediated request: the IT Admin has decided to serve themselves rather
    //     than wait for a colleague to press Send;
    //   - a code already verified ('sent', holding a live token): they verified
    //     but never finished choosing a password, and are now back asking for a
    //     code. Refreshing is impossible — that row is past the point a code
    //     lives on it — so it is closed and a fresh request opened, which also
    //     retires the token nobody used.
    const open = existing && existing.delivery_method === 'otp' && existing.status === 'pending'
      ? existing
      : null

    if (existing && !open) {
      await ResetModel.cancel(existing.request_id).catch((err) =>
        console.error('[password-reset] could not supersede open request', err),
      )
    }

    if (open) {
      const lastSent = open.otp_sent_at ? new Date(open.otp_sent_at).getTime() : 0
      if (Date.now() - lastSent < OTP_RESEND_COOLDOWN_SECS * 1000) {
        // Inside the cooldown. The previous code is still live and still in their
        // inbox, so the honest outcome is to send nothing - and to say nothing,
        // because a distinguishable "wait" is a signal that the address is real.
        return
      }
    }

    const code      = generateOtp()
    const codeHash  = await bcrypt.hash(code, BCRYPT_ROUNDS)
    const expiresAt = new Date(Date.now() + OTP_TTL_MINS * 60 * 1000)

    const request = open
      ? await ResetModel.refreshOtp(open.request_id, codeHash, expiresAt)
      : await ResetModel.createOtpRequest({
          user_id:        user.user_id,
          email,
          requested_role: user.role,
          otp_hash:       codeHash,
          otp_expires_at: expiresAt,
          requested_ip:   input.ip ?? null,
        })

    // refreshOtp comes back null when the row moved on under us - verified or
    // cancelled in another tab. Nothing to send, and nothing to say about it.
    if (!request) return

    try {
      await sendPasswordResetOtpEmail({
        to:               email,
        firstName:        user.first_name ?? null,
        code,
        expiresInMinutes: OTP_TTL_MINS,
      })
    } catch (err) {
      // No code reached the mailbox, so the row is a dead end. Close it rather
      // than leave a request nobody can satisfy sitting in the one open slot.
      await ResetModel.cancel(request.request_id).catch(() => {})
      throw err
    }

    logEvent({
      user_id:     user.user_id,
      log_type:    'user_activity',
      action:      'password_reset_otp_sent',
      description: `Self-service reset code sent to IT Admin ${email}, request ${request.request_id}`,
    })
  } catch (err) {
    // Swallowed for the same reason requestPasswordReset swallows: a failure that
    // answered differently from a success would be the oracle this endpoint is
    // written to avoid.
    if ((err as { code?: string })?.code === '23505') {
      console.info('[password-reset] concurrent OTP request for', email, '- existing row kept')
      return
    }
    console.error('[password-reset] requestItAdminOtp failed for', email, err)
  }
}

/**
 * Spend a code and hand back a one-time reset token.
 *
 * Unlike the request side, this one does talk: whoever is here holds a code that
 * was emailed to the account, and telling them "that code is wrong, 2 tries left"
 * is worth more to them than it is to an attacker who has to be reading the
 * mailbox already. What it never does is distinguish a wrong code from an expired
 * one from a request that does not exist - all three are the same sentence, so
 * the reply cannot be used to map the state of an account.
 */
export async function verifyItAdminOtp(input: {
  email: string
  code:  string
}): Promise<{ token: string; expires_at: string }> {
  const email = input.email.trim().toLowerCase()
  const code  = input.code.trim()

  const invalid = () => {
    const err = new Error('That code is invalid or has expired. Please request a new one.')
    ;(err as any).code = 'RESET_OTP_INVALID'
    return err
  }

  const user = await AuthModel.findUserByEmail(email)
  if (!user || !canSelfResetByOtp(user.role) || UNRESETTABLE_STATUSES.includes(user.status)) {
    throw invalid()
  }

  await ResetModel.expireStaleOtps().catch((err) =>
    console.error('[password-reset] expireStaleOtps failed', err),
  )

  const request = await ResetModel.findOpenOtpByUser(user.user_id)
  if (!request || !request.otp_hash || !request.otp_expires_at) throw invalid()
  if (new Date(request.otp_expires_at).getTime() <= Date.now()) throw invalid()

  if (request.otp_attempts >= MAX_OTP_ATTEMPTS) {
    await ResetModel.cancel(request.request_id).catch(() => {})
    throw invalid()
  }

  const matches = await bcrypt.compare(code, request.otp_hash)

  if (!matches) {
    const attempts = await ResetModel.bumpOtpAttempts(request.request_id, request.otp_attempts)
    const left     = MAX_OTP_ATTEMPTS - attempts

    await AuthModel.createLoginHistory({
      user_id: user.user_id,
      email,
      attempt_status: 'failed_otp',
      failure_reason: `Wrong self-service reset code (${Math.max(0, left)} attempts left)`,
    })

    if (left <= 0) {
      // Out of guesses. The request is torn down so the odds cannot be run up
      // across a long session - a new code means a new secret to guess.
      await ResetModel.cancel(request.request_id).catch(() => {})
      const err = new Error('Too many incorrect codes. Please request a new one.')
      ;(err as any).code = 'RESET_OTP_EXHAUSTED'
      throw err
    }

    const err = new Error(
      `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left before you need a new one.`,
    )
    ;(err as any).code = 'RESET_OTP_INCORRECT'
    throw err
  }

  const token     = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + OTP_RESET_TOKEN_TTL_MINS * 60 * 1000)

  const verified = await ResetModel.markOtpVerified(
    request.request_id,
    hashToken(token),
    expiresAt,
    user.user_id,
  )
  // Lost the race with another tab that spent the same code. The token that won
  // is the one in that tab, and it is not ours to hand out.
  if (!verified) throw invalid()

  logEvent({
    user_id:     user.user_id,
    log_type:    'user_activity',
    action:      'password_reset_otp_verified',
    description: `IT Admin ${email} verified a self-service reset code, request ${request.request_id}`,
  })

  return { token, expires_at: expiresAt.toISOString() }
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
