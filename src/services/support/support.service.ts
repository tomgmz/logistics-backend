import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import {
  sendSupportTicketEmail,
  sendSupportTicketResolvedEmail,
} from '../../lib/brevo-mailer.js'

/**
 * Client support tickets, raised from the web FAQ chatbot when it can't answer.
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
  clients ( company_name ),
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

  // A booking named on the ticket must be the client's own.
  let booking: { booking_id: string; reference_number: string | null } | null = null
  if (input.booking_id) {
    const { data, error } = await supabase
      .from('bookings')
      .select('booking_id, reference_number, client_id')
      .eq('booking_id', input.booking_id)
      .maybeSingle()
    if (error) throw error
    if (!data || data.client_id !== clientId) throw new Error('That booking was not found on your account')
    booking = data
  }

  const transcript = (input.transcript ?? [])
    .slice(-20)
    .map((m) => ({ from: m.from, text: String(m.text).slice(0, 1000) }))

  const { data: created, error } = await supabase
    .from('support_tickets')
    .insert({
      client_id:       clientId,
      opened_by:       userId,
      booking_id:      booking?.booking_id ?? null,
      category:        input.category,
      subject:         input.subject.trim(),
      message:         input.message.trim(),
      chat_transcript: transcript,
    })
    .select(TICKET_SELECT)
    .single()
  if (error) throw error

  const ticket  = withRef(created as any)
  const opener  = one((created as any).opener) as { first_name: string | null; last_name: string | null; email: string } | null
  const company = one((created as any).clients) as { company_name: string | null } | null
  const name    = [opener?.first_name, opener?.last_name].filter(Boolean).join(' ') || company?.company_name || 'Client'

  logEvent({
    user_id:     userId,
    log_type:    'user_activity',
    action:      'support_ticket_opened',
    description: `Client opened support ticket ${ticket.reference}: ${ticket.subject}`,
  })

  if (opener?.email) {
    const email = opener.email
    void sendSupportTicketEmail({
      reference:   ticket.reference,
      clientName:  name,
      companyName: company?.company_name ?? null,
      email,
      category:    CATEGORY_LABEL[input.category],
      subject:     ticket.subject,
      message:     ticket.message,
      bookingRef:  booking ? bookingRef(booking) : null,
      transcript,
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

  const opener  = one((data as any).opener) as { first_name: string | null; last_name: string | null; email: string } | null
  const company = one((data as any).clients) as { company_name: string | null } | null
  if (opener?.email) {
    void sendSupportTicketResolvedEmail({
      reference:  ticket.reference,
      clientName: [opener.first_name, opener.last_name].filter(Boolean).join(' ') || company?.company_name || 'Client',
      email:      opener.email,
      subject:    ticket.subject,
      note:       ticket.resolution_note,
    }).catch((err) => console.error('[support] resolved email failed', ticket.reference, err?.message))
  }
  return ticket
}
