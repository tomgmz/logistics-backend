import * as ResetModel from '../../models/auth/password-reset.model.js'
import { logSystem } from '../../lib/log-system.js'
import { PasswordResetRequestRow } from '../../types/password-reset.types.js'

/**
 * Keeping the password reset queue honest (user 2026-11-18).
 *
 * The queue used to keep a request for ever once its link expired, even after
 * the person had got back in another way, and Reject was off for those rows.
 * Like a ticket desk (ServiceNow closes resolved incidents after 7 days by
 * default, Zendesk solved tickets after 4), a request now closes by itself:
 *   - when that person signs in successfully (password, emailed code, passkey)
 *     or their password changes in any way: they are back in;
 *   - when a newer request from the same person replaces it;
 *   - 7 days after its link expired with nobody acting on it.
 * Closed = status 'cancelled' (the row stays as history); the reason is in
 * System Logs, since no person closed it (logSystem, not logEvent).
 *
 * Its own module so auth.service and webauthn.service can call it without
 * importing password-reset.service (which imports auth.service).
 */

/** How long an expired, untouched request stays in the queue. */
export const EXPIRED_REQUEST_KEEP_DAYS = 7

export type ResetCloseReason = 'signed_in' | 'password_changed' | 'replaced' | 'stale'

const REASON_TEXT: Record<ResetCloseReason, string> = {
  signed_in:        'they signed in successfully',
  password_changed: 'their password was changed',
  replaced:         'they asked again and a new request replaced it',
  stale:            `its link expired over ${EXPIRED_REQUEST_KEEP_DAYS} days ago and nobody acted on it`,
}

function logClosed(rows: PasswordResetRequestRow[], reason: ResetCloseReason): void {
  for (const r of rows) {
    logSystem({
      log_level:  'info',
      event_type: 'auth_event',
      source:     'password-reset',
      message:    `Password reset request for ${r.email} closed automatically: ${REASON_TEXT[reason]}.`,
      user_id:    null,
      metadata:   { request_id: r.request_id, previous_status: r.status, reason, account_user_id: r.user_id },
    })
  }
}

/**
 * Close this person's unfinished requests. Never throws and is never awaited
 * on a sign-in path: a queue tidy-up must not slow or break signing in.
 */
export function closeResetRequestsFor(userId: string, reason: ResetCloseReason): Promise<void> {
  return ResetModel.closeAllForUser(userId)
    .then((rows) => logClosed(rows, reason))
    .catch((err) => console.error('[password-reset] closing requests failed', err))
}

/** Close expired requests older than the keep window. Never throws. */
export async function closeStaleResetRequests(): Promise<void> {
  try {
    const before = new Date(Date.now() - EXPIRED_REQUEST_KEEP_DAYS * 86_400_000)
    logClosed(await ResetModel.closeExpiredBefore(before), 'stale')
  } catch (err) {
    console.error('[password-reset] closing stale requests failed', err)
  }
}

/** Close this person's expired requests only: a new request is about to replace them. */
export async function closeReplacedRequests(userId: string): Promise<void> {
  try {
    logClosed(await ResetModel.closeAllForUser(userId, ['expired']), 'replaced')
  } catch (err) {
    console.error('[password-reset] closing replaced requests failed', err)
  }
}
