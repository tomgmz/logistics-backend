import { broadcast } from '../../lib/realtime.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'

/**
 * Tell the IT Administrator that an account was signed out because a retired
 * sign-in (refresh) token was used again (refresh-token rotation, 2026-11-14).
 *
 * The account owner is told on their own screen at sign-out; the IT
 * Administrator is the one who can reset the password or deactivate the account
 * if the owner says it wasn't them.
 */

const ROLE_WORDS: Record<string, string> = {
  client:             'Client',
  driver:             'Driver',
  admin:              'Company Administrator',
  it_admin:           'IT Administrator',
  general_manager:    'General Manager',
  operations_manager: 'Operations Manager',
  fleet_manager:      'Fleet Manager',
}

const STAFF_ROLES = new Set(['admin', 'it_admin', 'general_manager', 'operations_manager', 'fleet_manager'])

export async function notifySessionReuse(account: {
  user_id:    string
  email:      string
  first_name: string | null
  last_name:  string | null
  role:       string
}): Promise<void> {
  const recipients = (await notificationModel.resolveRecipientsByRoles(['it_admin']))
    // An IT Administrator whose own token was reused is signed out already; the
    // System Logs entry is their record.
    .filter((r) => r.user_id !== account.user_id)
  if (recipients.length === 0) return

  const name  = [account.first_name, account.last_name].filter(Boolean).join(' ') || account.email
  const role  = ROLE_WORDS[account.role] ?? account.role
  const title = 'Account signed out for safety'
  const body  = `${name} (${role}) was signed out on every device: an old sign-in token was used again, `
    + 'which can mean it was copied. They need to sign in again. If they did not expect this, '
    + 'reset their password or deactivate the account.'
  const actionUrl = STAFF_ROLES.has(account.role)
    ? `/it_admin/administrator-management?search=${encodeURIComponent(account.email)}`
    : `/it_admin/administrator-management?tab=people&search=${encodeURIComponent(account.email)}`
  const data = {
    type:         'auth.session_reuse',
    account:      account.email,
    account_role: role,
    action_url:   actionUrl,
  }

  const rows: CreateNotificationInput[] = recipients.map(({ user_id }) => ({
    user_id,
    type:       'auth.session_reuse',
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
