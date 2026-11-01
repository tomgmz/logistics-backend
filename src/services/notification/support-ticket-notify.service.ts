import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'

/**
 * In-app notices for client support tickets, on top of the ticket emails:
 * a new ticket tells every active Company Administrator (except the one who
 * opened it), a ticket the office opened for a client tells that client, and
 * resolving one tells the client.
 *
 * Same shape as password-reset-notify: share the model and the three delivery
 * steps (row, live broadcast, push), not notifyStage's booking vocabulary.
 * Best effort throughout: the ticket is already saved, and a failed notice must
 * not fail the client's request or the admin's resolve.
 */

// Where the Company Administrator works the queue.
const ADMIN_TICKETS_PATH = '/admin/support-tickets'
// The client's tickets live in the help assistant; ?chat=tickets opens it there.
const CLIENT_TICKETS_PATH = '/client/dashboard?chat=tickets'

interface TicketSummary {
  ticket_id:  string
  reference:  string
  subject:    string
  booking_id: string | null
}

async function fanOut(
  recipients: { user_id: string }[],
  type:       'support.ticket_opened' | 'support.ticket_resolved' | 'support.ticket_logged',
  title:      string,
  body:       string,
  ticket:     TicketSummary,
  actionUrl:  string,
): Promise<void> {
  if (recipients.length === 0) return

  const data = {
    type,
    ticket_id:        ticket.ticket_id,
    reference_number: ticket.reference,
    subject:          ticket.subject,
    action_url:       actionUrl,
  }
  const rows: CreateNotificationInput[] = recipients.map(({ user_id }) => ({
    user_id,
    type,
    title,
    body,
    // The ticket may name a booking, but the notice is about the ticket: leave
    // booking_id null so nothing treats it as a booking-workflow step.
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

/**
 * A ticket was opened: every active Company Administrator hears about it.
 * `openedByStaff` is the staff member who logged it for the client — named in
 * the notice and not told about their own ticket.
 */
export async function notifyTicketOpened(
  ticket: TicketSummary,
  clientName: string,
  openedByStaff?: { userId: string; name: string },
): Promise<void> {
  try {
    const recipients = (await notificationModel.resolveRecipientsByRoles(['admin']))
      .filter((r) => r.user_id !== openedByStaff?.userId)
    if (recipients.length === 0) {
      if (openedByStaff) return
      // The ticket still shows on the Tickets page and reached the support inbox.
      console.error(`[support] no active Company Administrator to notify for ${ticket.reference}`)
      return
    }
    await fanOut(
      recipients,
      'support.ticket_opened',
      'New support ticket',
      openedByStaff
        ? `${openedByStaff.name} opened ${ticket.reference} for ${clientName}: ${ticket.subject}`
        : `${clientName} opened ${ticket.reference}: ${ticket.subject}`,
      ticket,
      ADMIN_TICKETS_PATH,
    )
  } catch (err) {
    console.error('[support] notifyTicketOpened failed', ticket.reference, err)
  }
}

/** The office opened a ticket for a client (they called, emailed, walked in): tell the client. */
export async function notifyTicketLogged(ticket: TicketSummary, clientUserId: string): Promise<void> {
  try {
    await fanOut(
      [{ user_id: clientUserId }],
      'support.ticket_logged',
      'Support ticket opened for you',
      `Our team opened ${ticket.reference} (${ticket.subject}) for you. We will reply by email.`,
      ticket,
      CLIENT_TICKETS_PATH,
    )
  } catch (err) {
    console.error('[support] notifyTicketLogged failed', ticket.reference, err)
  }
}

/** Staff resolved a ticket: tell the client's account (whoever opened it). */
export async function notifyTicketResolved(ticket: TicketSummary, clientUserId: string): Promise<void> {
  try {
    await fanOut(
      [{ user_id: clientUserId }],
      'support.ticket_resolved',
      'Support ticket resolved',
      `Your ticket ${ticket.reference} (${ticket.subject}) was marked resolved. If something is still wrong, reply to its email or open a new ticket.`,
      ticket,
      CLIENT_TICKETS_PATH,
    )
  } catch (err) {
    console.error('[support] notifyTicketResolved failed', ticket.reference, err)
  }
}
