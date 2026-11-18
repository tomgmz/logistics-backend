import axios from 'axios'
import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { logSystem } from '../../lib/log-system.js'
import { sendTicketReplyForward, sendTicketStaffReplyToClient, supportInboxEmail } from '../../lib/mailer.js'
import { notifyTicketReplied } from '../notification/support-ticket-notify.service.js'
import { ticketRef } from './support.service.js'

/**
 * Email replies on support tickets (user 2026-11-18, the Zendesk pattern).
 *
 * Ticket emails carry Reply-To: TICKET_REPLY_EMAIL, an address Resend receives
 * for us. Resend calls POST /api/webhooks/resend-inbound with `email.received`
 * (metadata only); the body is read from GET /emails/receiving/{id}.
 *
 *   - The ticket is the [TCK-000123] in the subject.
 *   - From the client's account email (and not failing DMARC): a client reply.
 *     The ticket shows "Client replied"; on a resolved ticket it reopens it, as
 *     Zendesk reopens a solved ticket when the requester writes back.
 *   - From the support inbox, or from the email of an active staff account
 *     (STAFF_ROLES): a staff reply, so the ticket reads "Waiting for client".
 *     A staff reply the client was not on (plain Reply on the ticket email, or
 *     an email to the reply address only) is sent on to the client, CC the
 *     inbox, so an answer can't silently stay with us.
 *   - Anyone else: recorded with their address, never reopens.
 *   - A reply that didn't also reach the inbox (the client pressed Reply, not
 *     Reply all) is passed on to the inbox, so staff keep working in Gmail.
 * Retried webhooks are stored once (email_id is unique). Nothing here throws.
 */

const RESEND_API = 'https://api.resend.com'
/** Accounts whose replies count as "Our team" (not the client, not a driver). */
const STAFF_ROLES = ['admin', 'it_admin', 'general_manager', 'operations_manager', 'fleet_manager']
const BODY_MAX   = 4000

interface ReceivedEmail {
  id:              string
  from:            string
  to?:             string[] | null
  cc?:             string[] | null
  subject?:        string | null
  text?:           string | null
  html?:           string | null
  headers?:        Record<string, string> | null
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null
}

/** "Name <a@b.c>" or "a@b.c" → its parts, the address lower-cased. */
export function parseAddress(raw: string | null | undefined): { email: string; name: string | null } {
  const s = String(raw ?? '').trim()
  const m = s.match(/^(.*?)<([^>]+)>\s*$/)
  if (m) {
    const name = m[1].trim().replace(/^"|"$/g, '').trim()
    return { email: m[2].trim().toLowerCase(), name: name || null }
  }
  return { email: s.toLowerCase(), name: null }
}

/** The ticket number in "[TCK-000123] …" / "Re: [TCK-000123] …". */
export function ticketNumberFrom(subject: string | null | undefined): number | null {
  const m = String(subject ?? '').match(/\bTCK-(\d{1,12})\b/i)
  return m ? Number(m[1]) : null
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<blockquote[\s\S]*$/i, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/**
 * Only the new part of a reply: cut at the quoted history mail apps add
 * ("On … wrote:", "-----Original Message-----", an Outlook From:/Sent: block,
 * or "> " lines).
 */
export function newPartOf(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    const next = (lines[i + 1] ?? '').trim()
    if (
      l.startsWith('>') ||
      /^-{2,}\s*original message\s*-{2,}$/i.test(l) ||
      /^on .+wrote:$/i.test(l) ||
      (/^on .+/i.test(l) && /wrote:$/i.test(next)) ||
      (/^from:\s.+/i.test(l) && /^(sent|date|to):\s/i.test(next)) ||
      /^_{5,}$/.test(l)
    ) { cut = i; break }
  }
  const fresh = lines.slice(0, cut).join('\n').trim()
  return (fresh || text.trim()).slice(0, BODY_MAX)
}

async function readReceived(emailId: string): Promise<ReceivedEmail> {
  const { data } = await axios.get<ReceivedEmail>(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    timeout: 15_000,
  })
  return data
}

/** An active staff account with this email, if any. */
async function staffAccountFor(email: string): Promise<{ first_name: string | null; last_name: string | null } | null> {
  if (!email) return null
  const { data } = await supabase
    .from('users')
    .select('first_name, last_name, role, status')
    .ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`))
    .in('role', STAFF_ROLES)
    .neq('status', 'archived')
    .limit(1)
  return (data?.[0] as any) ?? null
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

/** Handle one `email.received` event. Never throws. */
export async function handleInboundTicketEmail(emailId: string): Promise<void> {
  try {
    if (!emailId) return
    // A retried webhook: already stored.
    const { data: seen } = await supabase.from('support_ticket_replies').select('reply_id').eq('email_id', emailId).maybeSingle()
    if (seen) return

    const mail    = await readReceived(emailId)
    const sender  = parseAddress(mail.headers?.from ?? mail.from)
    const subject = mail.subject ?? ''
    const body    = newPartOf(mail.text ?? (mail.html ? htmlToText(mail.html) : ''))
    const inbox   = supportInboxEmail().toLowerCase()
    const recipients   = [...(mail.to ?? []), ...(mail.cc ?? [])].map((a) => parseAddress(a).email)
    const reachedInbox = recipients.includes(inbox)

    const number = ticketNumberFrom(subject)
    const { data: ticket } = number
      ? await supabase
          .from('support_tickets')
          .select('ticket_id, ticket_number, subject, status, reopen_count, clients ( company_name, user_id, users ( first_name, last_name, email ) )')
          .eq('ticket_number', number)
          .maybeSingle()
      : { data: null }

    if (!ticket) {
      // Someone wrote to the reply address about no ticket we know: the inbox still gets it.
      logSystem({
        log_level: 'info', event_type: 'email_event', source: 'tickets.inbound',
        message: `An email reached the ticket reply address with no matching ticket (subject "${subject.slice(0, 120)}"); passed on to the inbox.`,
      })
      if (!reachedInbox && sender.email !== inbox) {
        await sendTicketReplyForward({ subject: subject || '(no subject)', reference: 'no matching ticket', fromEmail: sender.email, fromName: sender.name, body })
      }
      return
    }

    const t       = ticket as any
    const client  = one(t.clients) as { company_name: string | null; user_id: string | null; users: any } | null
    const contact = one(client?.users) as { first_name: string | null; last_name: string | null; email: string | null } | null
    const clientEmail = contact?.email?.trim().toLowerCase() ?? null
    // A forged From fails DMARC; such a "client" reply is kept as other, never reopens.
    const dmarcFailed = String(mail.authentication?.dmarc ?? '').toLowerCase() === 'fail'
    const staffAccount = sender.email === inbox || sender.email === clientEmail ? null : await staffAccountFor(sender.email)
    const direction: 'client' | 'staff' | 'other' =
      sender.email === inbox ? 'staff'
      : sender.email === clientEmail && !dmarcFailed ? 'client'
      : staffAccount && !dmarcFailed ? 'staff'
      : 'other'
    const staffName = staffAccount ? [staffAccount.first_name, staffAccount.last_name].filter(Boolean).join(' ') || null : null
    const reference = ticketRef(t.ticket_number)

    const { error: insErr } = await supabase.from('support_ticket_replies').insert({
      ticket_id:  t.ticket_id,
      direction,
      from_email: sender.email,
      from_name:  sender.name ?? staffName,
      body_text:  body,
      email_id:   emailId,
    })
    // 23505: the same email arrived twice at once; the first one handles it.
    if (insErr) { if ((insErr as any).code === '23505') return; throw insErr }

    const now = new Date().toISOString()
    let reopened = false
    if (direction === 'client') {
      const update: Record<string, unknown> = { client_last_reply_at: now, updated_at: now }
      if (t.status === 'resolved') {
        Object.assign(update, { status: 'open', resolved_at: null, resolved_by: null, reopened_at: now, reopen_count: (t.reopen_count ?? 0) + 1 })
        reopened = true
      }
      await supabase.from('support_tickets').update(update).eq('ticket_id', t.ticket_id)
    } else if (direction === 'staff') {
      await supabase.from('support_tickets').update({ staff_last_reply_at: now, updated_at: now }).eq('ticket_id', t.ticket_id)
    }

    const clientName = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') || client?.company_name || 'The client'
    if (direction === 'client') {
      logEvent({
        user_id:     client?.user_id ?? null,
        log_type:    'user_activity',
        action:      reopened ? 'support_ticket_reopened' : 'support_ticket_replied',
        description: reopened
          ? `Client replied to resolved support ticket ${reference} by email; it was reopened`
          : `Client replied to support ticket ${reference} by email`,
      })
      void notifyTicketReplied({ ticket_id: t.ticket_id, reference, subject: t.subject, booking_id: null }, clientName, reopened)
    }

    // Safety net: a staff answer that didn't go to the client (plain Reply on
    // the ticket email goes to the reply address only) is sent on to them, CC
    // the inbox so the Gmail thread has it too.
    if (direction === 'staff' && clientEmail && !recipients.includes(clientEmail)) {
      await sendTicketStaffReplyToClient({
        subject:    subject || `Re: [${reference}] ${t.subject}`,
        reference,
        clientName,
        clientEmail,
        body,
      })
      logSystem({
        log_level: 'info', event_type: 'email_event', source: 'tickets.inbound',
        message: `A staff reply on ${reference} from ${sender.email} did not include the client, so it was sent on to them.`,
      })
      return
    }

    // Anything that missed the inbox (the client pressed Reply, or staff wrote
    // from their own address) is passed on, so the Gmail thread stays whole.
    if (!reachedInbox && sender.email !== inbox) {
      await sendTicketReplyForward({
        subject:   subject || `Re: [${reference}] ${t.subject}`,
        reference,
        fromEmail: sender.email,
        fromName:  sender.name,
        body,
        note: reopened
          ? 'The ticket was resolved, so this reply reopened it.'
          : direction === 'other' ? 'This address is not the client\'s account email, so the ticket was not changed.'
          : direction === 'staff' ? 'A staff reply sent from their own address; the client was on it.' : null,
      })
    }
  } catch (err: any) {
    logSystem({
      log_level: 'error', event_type: 'email_event', source: 'tickets.inbound',
      message: `Could not record a ticket email reply (Resend email ${emailId}): ${err?.response?.data?.message ?? err?.message ?? String(err)}`,
    })
  }
}
