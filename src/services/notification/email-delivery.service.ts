import { supabase } from '../../lib/supabase.js'
import { logSystem } from '../../lib/log-system.js'
import { broadcast } from '../../lib/realtime.js'
import { supportInboxEmail } from '../../lib/brevo-mailer.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'

/**
 * What happens after Brevo has taken an email: its delivery webhook
 * (routes/webhooks.routes.ts) reports the receiving server's answer, and this
 * turns a failure into something a person sees.
 *
 * Until 2026-11-09 the system only knew whether Brevo accepted a send. A
 * welcome email the school's Microsoft 365 refused showed "Sent" here and
 * "Error" only in Brevo's own log, and the client simply never got their
 * temporary password. Now every failed delivery writes a System Logs warning
 * naming the email, the account and the receiver's reason, and tells the
 * administrators who look after that account.
 *
 * Who is told:
 *   client / driver / unknown address  -> Company Administrators
 *   staff account                      -> the IT Administrator
 *   the IT Administrator's own address -> Company Administrators (the IT
 *                                         Administrator can't be reached by email)
 *
 * Best effort throughout: Brevo has already been answered 200 by the time this
 * runs, and nothing here may throw.
 */

export const DELIVERY_LOG_SOURCE = 'brevo.delivery'

/** The fields we read from one Brevo transactional webhook event. */
export interface BrevoDeliveryEvent {
  event?:        string
  email?:        string
  subject?:      string
  reason?:       string
  'message-id'?: string
  ts_epoch?:     number
  ts_event?:     number
}

/**
 * The receiving side said no, for good: a person has to act (fix the address,
 * ask the organisation to allow us, send the email again).
 */
const FAILED_EVENTS: Record<string, string> = {
  hard_bounce:   'bounced (the address does not exist or refuses mail)',
  hard_bounced:  'bounced (the address does not exist or refuses mail)',
  blocked:       'blocked by Brevo (this address bounced or complained before)',
  invalid_email: 'rejected as an invalid address',
  invalid:       'rejected as an invalid address', // the dashboard's "Invalid"
  error:         'refused by the receiving mail server',
}

/**
 * Worth a log line, not a notice: Brevo keeps retrying a soft bounce, and a
 * spam complaint means the email did arrive.
 */
const LOGGED_EVENTS: Record<string, string> = {
  soft_bounce: 'soft-bounced (temporary; Brevo retries it)',
  spam:        'marked as spam by the recipient',
  complaint:   'marked as spam by the recipient', // the dashboard's "Complaint"
  soft_bounced: 'soft-bounced (temporary; Brevo retries it)',
}

/** Which of our emails it was, from its subject (every subject is built in lib/brevo-mailer.ts). */
export function emailKind(subject: string): { label: string; advice: string } {
  const s = subject.trim()
  const resend = 'Check the address on the account. Once it is right, send a password reset link from the reset queue.'
  if (/^Welcome to /i.test(s))                     return { label: 'Welcome email (temporary password)', advice: resend }
  if (/password reset code/i.test(s))              return { label: 'Password reset code', advice: 'Check the address on the account, then ask them to request a new code.' }
  if (/verification code/i.test(s))                return { label: 'Sign-in code', advice: 'They can sign in with their password instead, or fix the address on the account and try again.' }
  if (/^Reset your /i.test(s))                     return { label: 'Password reset link', advice: resend }
  if (/driver sign-in/i.test(s))                   return { label: 'Driver sign-in setup link', advice: 'Check the address on the driver, then use "Resend setup link".' }
  if (/password was changed/i.test(s))             return { label: 'Password changed notice', advice: 'Check the address on the account.' }
  if (/password reset completed|first sign-in password set|password changed by/i.test(s))
                                                   return { label: 'Password change alert', advice: 'Check the address on the administrator account.' }
  if (/delivered .* please confirm/i.test(s))      return { label: 'Delivery confirmation request', advice: 'Tell the client by phone; the booking also shows in their portal.' }
  if (/license expires/i.test(s))                  return { label: 'License expiry reminder', advice: 'Tell the driver directly and check the address on their account.' }
  if (/contract ends/i.test(s))                    return { label: 'Contract reminder', advice: 'Contact the client directly and check the address on their account.' }
  if (/^Website enquiry/i.test(s))                 return { label: 'Website enquiry', advice: 'Check CONTACT_INBOX_EMAIL on the server.' }
  if (/^(Re: )?\[[A-Z]+-[\w-]+\] /.test(s))        return { label: 'Support ticket email', advice: 'Reply to the client by phone, and check the address on their account.' }
  return { label: s ? `"${s}" email` : 'An email', advice: 'Check the address it was sent to.' }
}

const STAFF_ROLES = new Set(['admin', 'general_manager', 'operations_manager', 'fleet_manager'])

const ROLE_WORDS: Record<string, string> = {
  client:             'Client',
  driver:             'Driver',
  admin:              'Company Administrator',
  it_admin:           'IT Administrator',
  general_manager:    'General Manager',
  operations_manager: 'Operations Manager',
  fleet_manager:      'Fleet Manager',
}

interface Account { user_id: string; role: string; name: string }

async function findAccount(email: string): Promise<Account | null> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role, first_name, last_name')
    .eq('email', email)
    .maybeSingle()
  if (error || !data) return null
  const d = data as { user_id: string; role: string; first_name: string | null; last_name: string | null }
  return { user_id: d.user_id, role: d.role, name: [d.first_name, d.last_name].filter(Boolean).join(' ') || email }
}

/** Earlier rows for this message: Brevo retries webhooks and can send two failure events for one email. */
async function priorRows(messageId: string): Promise<{ event: string; notified: boolean }[]> {
  if (!messageId) return []
  const { data, error } = await supabase
    .from('system_logs')
    .select('metadata')
    .eq('source', DELIVERY_LOG_SOURCE)
    .eq('metadata->>message_id', messageId)
    .limit(10)
  if (error || !data) return []
  return (data as { metadata: Record<string, unknown> | null }[]).map((r) => ({
    event:    String(r.metadata?.event ?? ''),
    notified: r.metadata?.notified === true,
  }))
}

// A Brevo-wide block (their IP listed somewhere) could fail hundreds of emails
// at once. Past this many notices an hour, failures are still logged but not
// sent to anyone's bell; the log line says so.
const NOTICE_CAP_PER_HOUR = 20
let noticeWindow = { start: 0, count: 0 }
function takeNoticeSlot(): boolean {
  const now = Date.now()
  if (now - noticeWindow.start > 60 * 60 * 1000) noticeWindow = { start: now, count: 0 }
  if (noticeWindow.count >= NOTICE_CAP_PER_HOUR) return false
  noticeWindow.count++
  return true
}

async function notify(
  roles: string[],
  excludeUserId: string | null,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<number> {
  const recipients = (await notificationModel.resolveRecipientsByRoles(roles))
    .filter((r) => r.user_id !== excludeUserId)
  if (recipients.length === 0) return 0

  const rows: CreateNotificationInput[] = recipients.map(({ user_id }) => ({
    user_id,
    type:       'email.undelivered',
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
  return recipients.length
}

export async function handleDeliveryEvent(ev: BrevoDeliveryEvent): Promise<void> {
  try {
    const event = String(ev.event ?? '').toLowerCase()
    const failed = FAILED_EVENTS[event]
    const logged = LOGGED_EVENTS[event]
    if (!failed && !logged) return // delivered, opened, request, deferred…

    const email     = String(ev.email ?? '').trim().toLowerCase()
    const subject   = String(ev.subject ?? '')
    const reason    = String(ev.reason ?? '').trim().slice(0, 500)
    const messageId = String(ev['message-id'] ?? '')
    if (!email) return

    const prior = await priorRows(messageId)
    if (prior.some((p) => p.event === event)) return // a webhook retry

    const kind    = emailKind(subject)
    const isInbox = email === supportInboxEmail().toLowerCase()
    const account = isInbox ? null : await findAccount(email)
    const who     = isInbox
      ? `${email} (the support inbox)`
      : account
        ? `${email} (${ROLE_WORDS[account.role] ?? account.role} · ${account.name})`
        : `${email} (no account with this address)`
    const what    = failed ?? logged
    const message = `${kind.label} to ${who} was ${what}${reason ? `: ${reason}` : '.'}`

    // Only a failure a person can act on goes to a bell, once per email.
    let notified = false
    let capped   = false
    if (failed && !prior.some((p) => p.notified)) {
      if (!takeNoticeSlot()) {
        capped = true
      } else {
        const staffAccount = !!account && STAFF_ROLES.has(account.role)
        const roles = staffAccount ? ['it_admin'] : ['admin']
        const actionUrl = !account
          ? null
          : staffAccount
            ? `/it_admin/administrator-management?search=${encodeURIComponent(email)}`
            : account.role === 'client' || account.role === 'driver'
              ? `/admin/user-management?search=${encodeURIComponent(email)}`
              : null // the IT Administrator's own address: no page of theirs to open
        const subjectName = account?.name ?? email
        const sent = await notify(
          roles,
          account?.user_id ?? null,
          'Email not delivered',
          `${kind.label} to ${subjectName} was not delivered. ${kind.advice}`,
          {
            type:       'email.undelivered',
            email_kind: kind.label,
            recipient:  email,
            ...(account ? { account_role: ROLE_WORDS[account.role] ?? account.role } : {}),
            ...(reason ? { reason } : {}),
            ...(actionUrl ? { action_url: actionUrl } : {}),
          },
        )
        notified = sent > 0
      }
    }

    logSystem({
      log_level:  failed ? 'warn' : 'info',
      event_type: 'email_event',
      source:     DELIVERY_LOG_SOURCE,
      message:    capped ? `${message} (no notice sent: more than ${NOTICE_CAP_PER_HOUR} failures this hour)` : message,
      // user_id is who acted; nobody did. The account is in the metadata.
      user_id:    null,
      metadata:   {
        event,
        recipient_user_id: account?.user_id ?? null,
        message_id: messageId || null,
        email_kind: kind.label,
        notified,
        ...(ev.ts_epoch ? { event_at: new Date(ev.ts_epoch).toISOString() } : {}),
      },
    })
  } catch (err) {
    console.error('[email-delivery] handling a Brevo event failed:', err)
  }
}
