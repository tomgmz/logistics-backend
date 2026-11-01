import { supabase } from '../../lib/supabase.js'
import { pool } from '../../lib/database.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import {
  sendSupportTicketEmail,
  sendSupportTicketResolvedEmail,
} from '../../lib/brevo-mailer.js'
import { notifyTicketLogged, notifyTicketOpened, notifyTicketResolved } from '../notification/support-ticket-notify.service.js'

/**
 * Client support tickets, raised from the web FAQ chatbot when it can't answer,
 * or opened by the office for a client who called, emailed or walked in
 * (`openTicketForClient`; `opened_by` is then the staff member).
 *
 * The client's own account is always the contact — the email, the in-app
 * notices and their ticket list — whoever opened the ticket.
 *
 * Resolved by email, in one shared thread: opening a ticket sends ONE email to
 * the client with the support inbox CC'd and replies going to the inbox; staff
 * answer with "Reply all" so it lands in the client's thread, then mark the
 * ticket resolved on their dashboard, which emails a short note to the same
 * people under the same subject.
 * Emails are best effort: the ticket is recorded either way and shows on the
 * dashboard, so a mail outage can't lose a client's problem.
 */

export const TICKET_CATEGORIES = ['booking', 'delivery', 'tracking', 'documents', 'account', 'other'] as const
export type TicketCategory = typeof TICKET_CATEGORIES[number]

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  booking:   'Booking',
  delivery:  'Delivery',
  tracking:  'Tracking',
  documents: 'Documents',
  account:   'Account',
  other:     'Other',
}

/** A client may have this many tickets open at once; more is almost always a repeat. */
const MAX_OPEN_PER_CLIENT = 5

const TICKET_SELECT = `
  ticket_id, ticket_number, client_id, opened_by, booking_id, category, subject, message,
  chat_transcript, status, resolved_at, resolved_by, resolution_note, created_at, updated_at,
  clients ( company_name, user_id, users ( first_name, last_name, email ) ),
  opener:users!support_tickets_opened_by_fkey ( first_name, last_name, email ),
  resolver:users!support_tickets_resolved_by_fkey ( first_name, last_name ),
  bookings ( booking_id, reference_number )
`

export function ticketRef(n: number | string): string {
  return `TCK-${String(n).padStart(6, '0')}`
}

function withRef<T extends { ticket_number: number }>(row: T) {
  return { ...row, reference: ticketRef(row.ticket_number) }
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

type Contact = { first_name: string | null; last_name: string | null; email: string | null }

/** The client's account: who the ticket emails and notices go to. */
function contactOf(row: any): { userId: string | null; contact: Contact | null; company: string | null } {
  const client = one(row?.clients) as { company_name: string | null; user_id: string | null; users: Contact | Contact[] | null } | null
  return { userId: client?.user_id ?? null, contact: one(client?.users ?? null), company: client?.company_name ?? null }
}

const personName = (p: { first_name: string | null; last_name: string | null } | null) =>
  [p?.first_name, p?.last_name].filter(Boolean).join(' ') || null

export interface OpenTicketInput {
  category:    TicketCategory
  subject:     string
  message:     string
  booking_id?: string | null
  transcript?: Array<{ from: 'client' | 'bot'; text: string }>
}

export async function openTicket(clientId: string, userId: string, input: OpenTicketInput) {
  const { count, error: countErr } = await supabase
    .from('support_tickets')
    .select('ticket_id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('status', 'open')
  if (countErr) throw countErr
  if ((count ?? 0) >= MAX_OPEN_PER_CLIENT) {
    throw new Error(
      `You already have ${MAX_OPEN_PER_CLIENT} open tickets. Reply to one of their emails instead, ` +
      'or wait until one is resolved.',
    )
  }
  return createTicket(clientId, userId, input, null)
}

export interface StaffTicketInput extends Omit<OpenTicketInput, 'transcript'> {
  client_id: string
}

/**
 * The office opens a ticket for a client. No open-ticket cap (that guards
 * against a client repeating themselves); the client must not be archived, and
 * a booking named on it must be theirs.
 */
export async function openTicketForClient(staffUserId: string, input: StaffTicketInput) {
  const { data: client, error } = await supabase
    .from('clients')
    .select('client_id, users ( status )')
    .eq('client_id', input.client_id)
    .maybeSingle()
  if (error) throw error
  const account = one((client as any)?.users) as { status: string | null } | null
  // An archived client is gone; their account no longer receives email.
  if (!client || !account || account.status === 'archived') throw new Error('Client not found')

  const { data: staff } = await supabase
    .from('users')
    .select('first_name, last_name')
    .eq('user_id', staffUserId)
    .maybeSingle()
  return createTicket(input.client_id, staffUserId, { ...input, transcript: [] }, {
    userId: staffUserId,
    name:   personName(staff as any) ?? 'The office',
  })
}

async function createTicket(
  clientId: string,
  openedBy: string,
  input: OpenTicketInput,
  staff: { userId: string; name: string } | null,
) {
  // A booking named on the ticket must be the client's own.
  let booking: { booking_id: string; reference_number: string | null } | null = null
  if (input.booking_id) {
    const { data, error } = await supabase
      .from('bookings')
      .select('booking_id, reference_number, client_id')
      .eq('booking_id', input.booking_id)
      .maybeSingle()
    if (error) throw error
    if (!data || data.client_id !== clientId) {
      throw new Error(staff ? 'That booking was not found on this client' : 'That booking was not found on your account')
    }
    booking = data
  }

  const transcript = (input.transcript ?? [])
    .slice(-20)
    .map((m) => ({ from: m.from, text: String(m.text).slice(0, 1000) }))

  const { data: created, error } = await supabase
    .from('support_tickets')
    .insert({
      client_id:       clientId,
      opened_by:       openedBy,
      booking_id:      booking?.booking_id ?? null,
      category:        input.category,
      subject:         input.subject.trim(),
      message:         input.message.trim(),
      chat_transcript: transcript,
    })
    .select(TICKET_SELECT)
    .single()
  if (error) throw error

  const ticket = withRef(created as any)
  const { userId: clientUserId, contact, company } = contactOf(created)
  const name = personName(contact) || company || 'Client'

  logEvent({
    user_id:     openedBy,
    log_type:    staff ? 'admin_activity' : 'user_activity',
    action:      'support_ticket_opened',
    description: staff
      ? `${staff.name} opened support ticket ${ticket.reference} for ${company ?? name}: ${ticket.subject}`
      : `Client opened support ticket ${ticket.reference}: ${ticket.subject}`,
  })

  void notifyTicketOpened(ticket, company ? `${name} (${company})` : name, staff ?? undefined)
  if (staff && clientUserId) void notifyTicketLogged(ticket, clientUserId)

  if (contact?.email) {
    void sendSupportTicketEmail({
      reference:   ticket.reference,
      clientName:  name,
      companyName: company,
      email:       contact.email,
      category:    CATEGORY_LABEL[input.category],
      subject:     ticket.subject,
      message:     ticket.message,
      bookingRef:  booking ? bookingRef(booking) : null,
      transcript,
      openedBy:    staff?.name ?? null,
    }).catch((err) => console.error('[support] ticket email failed', ticket.reference, err?.message))
  }

  return ticket
}

export async function listClientTickets(clientId: string) {
  const { data, error } = await supabase
    .from('support_tickets')
    .select(TICKET_SELECT)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []).map((r: any) => withRef(r))
}

export async function listTickets(status: 'open' | 'resolved' | 'all') {
  let q = supabase
    .from('support_tickets')
    .select(TICKET_SELECT)
    .order('created_at', { ascending: status === 'open' })
    .limit(100)
  if (status !== 'all') q = q.eq('status', status)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((r: any) => withRef(r))
}

export async function countOpenTickets(): Promise<number> {
  const { count, error } = await supabase
    .from('support_tickets')
    .select('ticket_id', { count: 'exact', head: true })
    .eq('status', 'open')
  if (error) throw error
  return count ?? 0
}

export async function resolveTicket(ticketId: string, actorId: string, note: string | null) {
  const { data: existing, error: readErr } = await supabase
    .from('support_tickets')
    .select(TICKET_SELECT)
    .eq('ticket_id', ticketId)
    .maybeSingle()
  if (readErr) throw readErr
  if (!existing) throw new Error('Ticket not found')
  if ((existing as any).status === 'resolved') return withRef(existing as any)

  const { data, error } = await supabase
    .from('support_tickets')
    .update({
      status:          'resolved',
      resolved_at:     new Date().toISOString(),
      resolved_by:     actorId,
      resolution_note: note?.trim() || null,
      updated_at:      new Date().toISOString(),
    })
    .eq('ticket_id', ticketId)
    .eq('status', 'open')
    .select(TICKET_SELECT)
    .single()
  if (error) throw error

  const ticket = withRef(data as any)
  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'support_ticket_resolved',
    description: `Support ticket ${ticket.reference} marked resolved`,
  })

  const { userId: clientUserId, contact, company } = contactOf(data)
  if (clientUserId) void notifyTicketResolved(ticket, clientUserId)

  if (contact?.email) {
    void sendSupportTicketResolvedEmail({
      reference:  ticket.reference,
      clientName: personName(contact) || company || 'Client',
      email:      contact.email,
      subject:    ticket.subject,
      note:       ticket.resolution_note,
    }).catch((err) => console.error('[support] resolved email failed', ticket.reference, err?.message))
  }
  return ticket
}

/* ── Pickers for a ticket the office opens ───────────────────────────────── */

const likeTerm = (s: string) => `%${s.replace(/[\%_]/g, (c) => `\${c}`)}%`

export interface TicketClientOption {
  client_id:    string
  company_name: string | null
  contact_name: string | null
  email:        string | null
}

/** Clients to open a ticket for, by company, contact name or email. Archived ones are left out. */
export async function searchTicketClients(search: string, limit = 10): Promise<TicketClientOption[]> {
  const params: unknown[] = []
  let match = ''
  if (search.trim()) {
    params.push(likeTerm(search.trim()))
    match = ` AND (COALESCE(c.company_name, '') ILIKE $1 ESCAPE '\'
              OR concat_ws(' ', u.first_name, u.last_name) ILIKE $1 ESCAPE '\'
              OR COALESCE(u.email, '') ILIKE $1 ESCAPE '\')`
  }
  params.push(limit)
  const { rows } = await pool.query<TicketClientOption>(
    `SELECT c.client_id::text AS client_id, c.company_name,
            NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS contact_name, u.email
       FROM clients c
       JOIN users u ON u.user_id = c.user_id
      WHERE u.status <> 'archived'${match}
      ORDER BY c.company_name ASC NULLS LAST
      LIMIT $${params.length}`,
    params,
  )
  return rows
}

export interface TicketBookingOption {
  booking_id:       string
  reference_number: string | null
  status:           string
  schedule_date:    string | null
}

/** One client's most recent bookings, for naming one on the ticket. */
export async function ticketClientBookings(clientId: string, limit = 30): Promise<TicketBookingOption[]> {
  const { rows } = await pool.query<TicketBookingOption>(
    `SELECT booking_id::text AS booking_id, reference_number, status::text AS status,
            to_char(schedule_date, 'YYYY-MM-DD') AS schedule_date
       FROM bookings
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [clientId, limit],
  )
  return rows
}
