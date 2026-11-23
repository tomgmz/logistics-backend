import { broadcast } from '../../lib/realtime.js'
import { sendAccountLockedEmail, formatManilaTimestamp } from '../../lib/mailer.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'
import { canSelfResetByOtp } from '../auth/password-reset.service.js'

/**
 * An account was locked for good after 9 wrong passwords or codes in a row
 * (lockAfterFailures, auth.service.ts). User 2026-11-19: tell the IT
 * Administrator and the account owner.
 *
 * - IT Administrator: in-app notification + push. They reset the password,
 *   which unlocks the account, or look into it if the owner says it wasn't them.
 * - Owner: an email (they cannot sign in to see anything in the app), saying how
 *   to get back in and what to do if it wasn't them.
 *
 * An IT Administrator who locks their own account gets only the email: they
 * reset themselves by emailed code.
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

export async function notifyAccountLocked(account: {
  user_id:    string
  email:      string
  first_name: string | null
  last_name:  string | null
  role:       string
}): Promise<void> {
  const lockedAt = formatManilaTimestamp()

  const emailed = sendAccountLockedEmail({
    to:        account.email,
    firstName: account.first_name,
    lockedAt,
    selfReset: canSelfResetByOtp(account.role),
  })

  const recipients = (await notificationModel.resolveRecipientsByRoles(['it_admin']))
    .filter((r) => r.user_id !== account.user_id)

  if (recipients.length > 0) {
    const name  = [account.first_name, account.last_name].filter(Boolean).join(' ') || account.email
    const role  = ROLE_WORDS[account.role] ?? account.role
    const title = 'Account locked'
    const body  = `${name} (${role}) was locked after 9 wrong passwords or sign-in codes in a row. `
      + 'A password reset unlocks it. If they say it was not them, someone may be guessing their password.'
    const actionUrl = STAFF_ROLES.has(account.role)
      ? `/it_admin/administrator-management?search=${encodeURIComponent(account.email)}`
      : `/it_admin/administrator-management?tab=people&search=${encodeURIComponent(account.email)}`
    const data = {
      type:         'auth.account_locked',
      account:      account.email,
      account_role: role,
      action_url:   actionUrl,
    }

    const rows: CreateNotificationInput[] = recipients.map(({ user_id }) => ({
      user_id,
      type:       'auth.account_locked',
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

  await emailed
}
