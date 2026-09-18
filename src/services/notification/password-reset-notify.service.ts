import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'
import { PasswordResetRequestRow, ResetHandlerGroup } from '../../types/password-reset.types.js'

/**
 * Fan-out for password-reset requests.
 *
 * Deliberately separate from notifyStage(), which is booking-shaped (it takes a
 * BookingWithRelations and deep-links off a booking_id). This follows the same
 * precedent as billing-notify.service and report.service's notifyResponders:
 * share the model and the three delivery steps, not the booking vocabulary.
 */

// Which role staffs each queue. The split is the product rule: the Company Admin
// looks after the people outside the office (drivers and clients), the IT Admin
// looks after everyone with a desk.
const GROUP_ROLE: Record<ResetHandlerGroup, string> = {
  company_admin: 'admin',
  it_admin:      'it_admin',
}

// Where each admin's queue lives, so the notification tap lands on the tab that
// has the Send button rather than on a dashboard.
const GROUP_QUEUE_PATH: Record<ResetHandlerGroup, string> = {
  company_admin: '/admin/user-management',
  it_admin:      '/it_admin/administrator-management',
}

const ROLE_LABELS: Record<string, string> = {
  admin:              'Company Admin',
  it_admin:           'IT Admin',
  general_manager:    'General Manager',
  fleet_manager:      'Fleet Manager',
  operations_manager: 'Operations Manager',
  accountant:         'Accountant',
  driver:             'Driver',
  client:             'Client',
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ')
}

function requesterLabel(request: PasswordResetRequestRow, name?: string | null): string {
  const who = name?.trim() || request.email
  return `${who} (${roleLabel(request.requested_role)})`
}

function queueUrl(group: ResetHandlerGroup, requestId: string): string {
  return `${GROUP_QUEUE_PATH[group]}?tab=password-resets&request=${encodeURIComponent(requestId)}`
}

/**
 * Deliver one notification to a set of recipients: persist a row each, broadcast
 * to their open dashboards, and push to their devices.
 *
 * Best effort throughout — the request is already saved, and a dead push token
 * must not fail the user's "forgot password" call.
 */
async function fanOut(
  recipients: { user_id: string }[],
  type:       'auth.password_reset_requested' | 'auth.password_reset_completed',
  title:      string,
  body:       string,
  data:       Record<string, unknown>,
): Promise<void> {
  if (recipients.length === 0) return

  const rows: CreateNotificationInput[] = recipients.map(({ user_id }) => ({
    user_id,
    type,
    title,
    body,
    booking_id: null,
    data,
  }))

  const inserted = await notificationModel.insertMany(rows)

  void Promise.allSettled(
    inserted.map((row: NotificationRow) =>
      broadcast(`notifications:user:${row.user_id}`, 'new_notification', row),
    ),
  )

  void push.sendToUsers(recipients.map((r) => r.user_id), { title, body, data })
}

/** Tell the owning admin group that someone is locked out and waiting. */
export async function notifyResetRequested(
  request:       PasswordResetRequestRow,
  requesterName: string | null,
): Promise<void> {
  try {
    const role       = GROUP_ROLE[request.handler_group]
    const recipients = await notificationModel.resolveRecipientsByRoles([role])
    if (recipients.length === 0) {
      // Nobody staffs this queue, so the request would sit unseen. Loud, because
      // the user has been told an admin was notified.
      console.error(
        `[password-reset] no active '${role}' to notify for request ${request.request_id}`,
      )
      return
    }

    await fanOut(
      recipients,
      'auth.password_reset_requested',
      'Password reset requested',
      `${requesterLabel(request, requesterName)} asked for a password reset. Send them a reset link to let them back in.`,
      {
        type:          'auth.password_reset_requested',
        request_id:    request.request_id,
        requested_role: request.requested_role,
        handler_group: request.handler_group,
        action_url:    queueUrl(request.handler_group, request.request_id),
      },
    )
  } catch (err) {
    console.error('[password-reset] notifyResetRequested failed', request.request_id, err)
  }
}

/**
 * Close the loop for the admin who sent the link, so they can see the reset
 * landed without going back to the queue to check.
 *
 * Addressed to the individual who sent it, with a fall back to whoever staffs
 * that queue now. The sender may have left — an IT Admin handover deactivates the
 * outgoing account, and `sent_by` keeps pointing at them — and a notification
 * delivered to an account nobody can sign into is the same as no notification at
 * all. The fallback is also what covers a self-served OTP reset, where `sent_by`
 * is the requester themselves.
 */
export async function notifyResetCompleted(
  request:       PasswordResetRequestRow,
  requesterName: string | null,
): Promise<void> {
  try {
    // One lookup, two uses: it answers both "is the original sender still active?"
    // and "who staffs this queue now?".
    const active = await notificationModel.resolveRecipientsByRoles([GROUP_ROLE[request.handler_group]])
    const sender = active.filter((r) => r.user_id === request.sent_by)
    const recipients = sender.length ? sender : active

    if (recipients.length === 0) return

    await fanOut(
      recipients,
      'auth.password_reset_completed',
      'Password reset completed',
      `${requesterLabel(request, requesterName)} set a new password and can sign in again.`,
      {
        type:          'auth.password_reset_completed',
        request_id:    request.request_id,
        requested_role: request.requested_role,
        handler_group: request.handler_group,
        action_url:    queueUrl(request.handler_group, request.request_id),
      },
    )
  } catch (err) {
    console.error('[password-reset] notifyResetCompleted failed', request.request_id, err)
  }
}
