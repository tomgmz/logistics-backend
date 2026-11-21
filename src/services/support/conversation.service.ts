import { supabase } from '../../lib/supabase.js'
import { broadcast } from '../../lib/realtime.js'
import { logEvent } from '../../lib/log-event.js'
import { logSystem } from '../../lib/log-system.js'
import { isOfficeOpen, lastClosing, AFTER_HOURS_TEXT } from '../../lib/office-hours.js'
import { sendConversationReplyEmail, sendConversationReminderEmail } from '../../lib/mailer.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import type { CreateNotificationInput, NotificationRow, NotificationType } from '../../types/notification.types.js'

/**
 * Client support conversations: the help assistant, our team and email in one
 * thread (user 2026-11-22, the Intercom / Zendesk model).
 *
 *   assistant  the client is talking to the help assistant (staff never see
 *              it in Waiting); the web posts each question + answer here
 *   waiting    handed to the team ("Talk to our team"), or the client wrote
 *              after a staff reply: every Operations Manager and Company
 *              Administrator is alerted (later: whoever replied last)
 *   replied    the team answered; waiting on the client. A reply the client
 *              hasn't read in 15 minutes is emailed; answering that email adds
 *              to the conversation. Quiet 3 days → a reminder; 7 days → resolved.
 *   resolved   by staff or by itself. A client message within 7 days reopens
 *              it; after that they start a new conversation.
 *
 * Staff = the Company Administrator and the Operations Manager (the desk that
 * already handles tickets).
 *
 * Tickets are separate (user 2026-11-22: turning a conversation into a ticket
 * was dropped as too complicated). Staff open tickets from the Tickets tab.
 *
 * Collisions (user 2026-11-22, Zendesk's three layers): the first staff
 * member to reply owns the conversation (assigned_to); anyone else must "Take
 * over" before replying while the owner is still active. A reply sent after a
 * colleague replied that the sender hadn't seen is refused with code
 * 'updated' unless they confirm. The web adds "… is viewing" / typing.
 */

export const TEAM_ROLES = ['admin', 'operations_manager']
export const REOPEN_DAYS      = 7
/**
 * Closing timers (user 2026-11-22; Freshchat / respond.io / Zoho close a quiet
 * bot chat after 24 h; Intercom and Zendesk close a customer-silent one after
 * about a week, Zendesk with a reminder first):
 *   assistant only, client quiet 24 h          → closed
 *   team replied, client quiet 3 days          → reminder (line + bell + email)
 *   …still quiet at 7 days (after the reminder) → closed
 */
export const ASSISTANT_CLOSE_HOURS = 24
export const REMIND_AFTER_DAYS = 3
export const AUTO_RESOLVE_DAYS = 7
export const EMAIL_AFTER_MIN  = 15

export type ConversationStatus = 'assistant' | 'waiting' | 'replied' | 'resolved'
export type Author = 'client' | 'assistant' | 'staff' | 'system'

export interface ConversationRow {
  conversation_id:        string
  conversation_number:    number
  client_id:              string
  client_user_id:         string
  title:                  string
  status:                 ConversationStatus
  handed_over_at:         string | null
  last_message_at:        string
  last_client_message_at: string | null
  last_staff_message_at:  string | null
  last_staff_replier_id:  string | null
  /** The owner: the first staff member to reply; "Take over" moves it. */
  assigned_to:            string | null
  assigned_at:            string | null
  resolved_at:            string | null
  resolved_by:            string | null
  resolved_reason:        'staff' | 'auto' | null
  ticket_id:              string | null
  after_hours_notice_at:  string | null
  emailed_at:             string | null
  /** When the "did this solve it?" reminder went out (3 quiet days after a staff reply). */
  reminded_at:            string | null
  created_at:             string
  updated_at:             string
}

export interface MessageRow {
  message_id:         string
  conversation_id:    string
  author:             Author
  author_id:          string | null
  content:            string
  attachment_url:     string | null
  attachment_stamped: boolean
  via:                'chat' | 'email'
  meta:               Record<string, unknown> | null
  created_at:         string
}

const err = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })

export function conversationRef(n: number | string): string {
  return `CHT-${String(n).padStart(6, '0')}`
}

/** The conversation number in "[CHT-000123] …" / "Re: [CHT-000123] …". */
export function conversationNumberFrom(subject: string | null | undefined): number | null {
  const m = String(subject ?? '').match(/\bCHT-(\d{1,12})\b/i)
  return m ? Number(m[1]) : null
}

const personName = (u: { first_name?: string | null; last_name?: string | null } | null | undefined) =>
  [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim()

const ROLE_LABEL: Record<string, string> = {
  admin: 'Company Administrator', operations_manager: 'Operations Manager',
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function getConversation(id: string): Promise<ConversationRow> {
  const { data, error } = await supabase.from('support_conversations').select('*').eq('conversation_id', id).maybeSingle()
  if (error) throw error
  if (!data) throw err('Conversation not found', 404)
  return data as ConversationRow
}

async function messagesOf(id: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from('support_messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }).limit(500)
  if (error) throw error
  return (data ?? []) as MessageRow[]
}

/** Names (with roles) of everyone who wrote, for the bubbles. */
async function authorsOf(messages: MessageRow[]): Promise<Record<string, { name: string; role: string }>> {
  const ids = [...new Set(messages.map((m) => m.author_id).filter(Boolean))] as string[]
  if (!ids.length) return {}
  const { data } = await supabase.from('users').select('user_id, first_name, last_name, role').in('user_id', ids)
  return Object.fromEntries((data ?? []).map((u: any) => [u.user_id, { name: personName(u) || 'Our team', role: u.role }]))
}

async function readAt(conversationIds: string[], userId: string): Promise<Record<string, string>> {
  if (!conversationIds.length) return {}
  const { data } = await supabase
    .from('support_conversation_reads').select('conversation_id, last_read_at')
    .eq('user_id', userId).in('conversation_id', conversationIds)
  return Object.fromEntries((data ?? []).map((r: any) => [r.conversation_id, r.last_read_at]))
}

/** Last message preview + unread count for each conversation, for the reader. */
async function summaries(rows: ConversationRow[], readerId: string, readerIsClient: boolean) {
  const ids = rows.map((r) => r.conversation_id)
  if (!ids.length) return []
  const [{ data: msgs }, reads] = await Promise.all([
    supabase.from('support_messages')
      .select('conversation_id, author, author_id, content, attachment_url, created_at')
      .in('conversation_id', ids).order('created_at', { ascending: false }).limit(2000),
    readAt(ids, readerId),
  ])
  const last: Record<string, any> = {}
  const unread: Record<string, number> = {}
  for (const m of (msgs ?? []) as any[]) {
    if (!last[m.conversation_id] && m.author !== 'system') last[m.conversation_id] = m
    // Unread = someone else's message after the reader's last read. For a
    // client, only the team's (the assistant's answers arrive while they watch).
    const fromOther = readerIsClient ? m.author === 'staff' : m.author === 'client'
    const seen = reads[m.conversation_id]
    if (fromOther && (!seen || m.created_at > seen)) unread[m.conversation_id] = (unread[m.conversation_id] ?? 0) + 1
  }
  return rows.map((r) => ({
    ...r,
    reference:    conversationRef(r.conversation_number),
    last_message: last[r.conversation_id]
      ? { author: last[r.conversation_id].author, content: last[r.conversation_id].content || (last[r.conversation_id].attachment_url ? 'Photo' : ''), created_at: last[r.conversation_id].created_at }
      : null,
    unread_count: unread[r.conversation_id] ?? 0,
  }))
}

/** A client's conversations, newest first. */
export async function listForClient(clientUserId: string) {
  const { data, error } = await supabase
    .from('support_conversations').select('*').eq('client_user_id', clientUserId)
    .order('last_message_at', { ascending: false }).limit(100)
  if (error) throw error
  return summaries((data ?? []) as ConversationRow[], clientUserId, true)
}

async function requireOwn(id: string, clientUserId: string): Promise<ConversationRow> {
  const conv = await getConversation(id)
  if (conv.client_user_id !== clientUserId) throw err('Conversation not found', 404)
  return conv
}

/** One conversation with its messages and writers' names. */
async function detail(conv: ConversationRow) {
  const messages = await messagesOf(conv.conversation_id)
  return { ...conv, reference: conversationRef(conv.conversation_number), messages, authors: await authorsOf(messages) }
}

export async function getForClient(id: string, clientUserId: string) {
  return detail(await requireOwn(id, clientUserId))
}

export async function getForStaff(id: string) {
  const conv = await getConversation(id)
  const [base, client] = await Promise.all([
    detail(conv),
    supabase.from('clients').select('company_name, users ( first_name, last_name, email )').eq('client_id', conv.client_id).maybeSingle(),
  ])
  const c: any = client.data
  const u: any = Array.isArray(c?.users) ? c.users[0] : c?.users
  let assignee_name: string | null = null
  if (conv.assigned_to) {
    const { data: a } = await supabase.from('users').select('first_name, last_name').eq('user_id', conv.assigned_to).maybeSingle()
    assignee_name = personName(a as any) || null
  }
  return { ...base, company_name: c?.company_name ?? null, client_name: personName(u) || null, client_email: u?.email ?? null, assignee_name }
}

/** The staff inbox: every conversation that ever reached the team, plus counts. */
export async function listForStaff(readerId: string) {
  const { data, error } = await supabase
    .from('support_conversations')
    .select('*, clients ( company_name, users ( first_name, last_name ) ), assignee:users!support_conversations_assigned_to_fkey ( first_name, last_name )')
    .order('last_message_at', { ascending: false }).limit(1000)
  if (error) throw error
  const rows = (data ?? []) as (ConversationRow & { clients: any })[]
  const withSummary = await summaries(rows, readerId, false)
  return withSummary.map((r: any) => {
    const u = Array.isArray(r.clients?.users) ? r.clients.users[0] : r.clients?.users
    return {
      ...r, company_name: r.clients?.company_name ?? null, client_name: personName(u) || null,
      assignee_name: r.assignee ? personName(r.assignee) || null : null, clients: undefined, assignee: undefined,
    }
  })
}

export async function markRead(id: string, userId: string, asClient: boolean): Promise<void> {
  if (asClient) await requireOwn(id, userId)
  else await getConversation(id)
  const { error } = await supabase.from('support_conversation_reads')
    .upsert({ conversation_id: id, user_id: userId, last_read_at: new Date().toISOString() }, { onConflict: 'conversation_id,user_id' })
  if (error) throw error
}

// ── Writing ──────────────────────────────────────────────────────────────────

async function insertMessage(row: Omit<MessageRow, 'message_id' | 'created_at' | 'attachment_stamped' | 'via' | 'meta' | 'attachment_url'> &
  Partial<Pick<MessageRow, 'attachment_url' | 'attachment_stamped' | 'via' | 'meta'>> & { email_id?: string }): Promise<MessageRow> {
  const { data, error } = await supabase.from('support_messages').insert(row).select('*').single()
  if (error) throw error
  return data as MessageRow
}

async function update(id: string, patch: Partial<ConversationRow>): Promise<void> {
  const { error } = await supabase.from('support_conversations')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('conversation_id', id)
  if (error) throw error
}

/** Live: the open conversation (both sides) and the client's list. */
function announce(conv: ConversationRow, message: MessageRow | null): void {
  if (message) void broadcast(`support:conv:${conv.conversation_id}`, 'new_message', message)
  void broadcast(`support:user:${conv.client_user_id}`, 'conversation_updated', { conversation_id: conv.conversation_id })
}

async function systemLine(conv: ConversationRow, event: string, content: string): Promise<void> {
  const m = await insertMessage({ conversation_id: conv.conversation_id, author: 'system', author_id: null, content, meta: { event } })
  announce(conv, m)
}

async function activeTeamIds(): Promise<string[]> {
  const { data, error } = await supabase.from('users').select('user_id').eq('status', 'active').in('role', TEAM_ROLES)
  if (error) throw error
  return (data ?? []).map((u: any) => u.user_id)
}

/** Bell + live + push, best effort. */
async function notify(
  userIds: string[], type: NotificationType, title: string, body: string,
  data: (userId: string) => Record<string, unknown>,
): Promise<void> {
  if (!userIds.length) return
  try {
    const rows: CreateNotificationInput[] = userIds.map((user_id) => ({ user_id, type, title, body, booking_id: null, data: { type, ...data(user_id) } }))
    const inserted = await notificationModel.insertMany(rows)
    void Promise.allSettled(inserted.map((row: NotificationRow) => broadcast(`notifications:user:${row.user_id}`, 'new_notification', row)))
    for (const uid of userIds) {
      void push.sendToUsers([uid], { title, body, data: { type, ...data(uid) }, tag: `support:${String(data(uid).conversation_id ?? '')}` })
    }
  } catch (e) {
    console.error('[support-chat] notice failed', type, e)
  }
}

async function staffPathFor(userIds: string[]): Promise<Record<string, string>> {
  if (!userIds.length) return {}
  const { data } = await supabase.from('users').select('user_id, role').in('user_id', userIds)
  return Object.fromEntries((data ?? []).map((u: any) => [
    u.user_id, `${u.role === 'operations_manager' ? '/operations_admin' : '/admin'}/support-tickets?tab=conversations`,
  ]))
}

async function companyOf(conv: ConversationRow): Promise<string> {
  const { data } = await supabase.from('clients').select('company_name').eq('client_id', conv.client_id).maybeSingle()
  return (data as any)?.company_name || 'A client'
}

/** Tell the team the client is waiting: whoever replied last, else everyone. */
async function alertTeam(conv: ConversationRow, preview: string, first: boolean): Promise<void> {
  const team  = await activeTeamIds()
  // The owner, else whoever replied last, else (or on the first handover) everyone.
  const owner = [conv.assigned_to, conv.last_staff_replier_id].find((id) => id && team.includes(id))
  const to    = owner && !first ? [owner] : team
  const company = await companyOf(conv)
  const paths   = await staffPathFor(to)
  void notify(to, 'support.chat_waiting',
    first ? `${company} needs our team` : `${company} replied`,
    `${conv.title ? `${conv.title}: ` : ''}${push.preview(preview)}`,
    (uid) => ({ conversation_id: conv.conversation_id, reference_number: conversationRef(conv.conversation_number), action_url: paths[uid] ?? '/admin/support-tickets' }))
}

/** Outside office hours, one "we're back at 8 AM" line per closed period. */
async function afterHoursNotice(conv: ConversationRow): Promise<void> {
  const now = new Date()
  if (isOfficeOpen(now)) return
  if (conv.after_hours_notice_at && new Date(conv.after_hours_notice_at) >= lastClosing(now)) return
  const base = supabase.from('support_conversations').update({ after_hours_notice_at: now.toISOString() }).eq('conversation_id', conv.conversation_id)
  const { data } = await (conv.after_hours_notice_at
    ? base.eq('after_hours_notice_at', conv.after_hours_notice_at)
    : base.is('after_hours_notice_at', null)).select('conversation_id')
  if (data?.length) await systemLine(conv, 'after_hours', AFTER_HOURS_TEXT)
}

/** A client starts a conversation (their first question to the assistant). */
export async function create(clientId: string, clientUserId: string, title: string): Promise<ConversationRow> {
  const { data, error } = await supabase.from('support_conversations')
    .insert({ client_id: clientId, client_user_id: clientUserId, title: title.trim().slice(0, 150) })
    .select('*').single()
  if (error) throw error
  const conv = data as ConversationRow
  announce(conv, null)
  return conv
}

/**
 * The assistant part: the web posts each question and the answer it showed.
 * Only while the assistant is still the one answering. The answers are the
 * client's own record of what they were told (like a ticket's transcript).
 */
export async function appendAssistantLines(
  id: string, clientUserId: string,
  lines: { author: 'client' | 'assistant'; text: string; meta?: Record<string, unknown> | null }[],
): Promise<MessageRow[]> {
  const conv = await requireOwn(id, clientUserId)
  // An assistant-only conversation that closed after 24 h reopens with the
  // assistant (never handed over, so it never goes to the team by itself).
  const assistantOnlyClosed = conv.status === 'resolved' && !conv.handed_over_at
  if (conv.status !== 'assistant' && !assistantOnlyClosed) throw err('Our team has this conversation now; write to them instead', 409)
  if (assistantOnlyClosed) {
    await update(id, { status: 'assistant', resolved_at: null, resolved_by: null, resolved_reason: null })
  }
  const out: MessageRow[] = []
  for (const l of lines) {
    const m = await insertMessage({
      conversation_id: id, author: l.author, author_id: l.author === 'client' ? clientUserId : null,
      content: l.text.slice(0, 4000), meta: l.meta ?? null,
    })
    out.push(m)
  }
  const now = new Date().toISOString()
  const firstQuestion = lines.find((l) => l.author === 'client')?.text
  await update(id, {
    last_message_at: now,
    ...(lines.some((l) => l.author === 'client') ? { last_client_message_at: now } : {}),
    ...(!conv.title && firstQuestion ? { title: firstQuestion.slice(0, 150) } : {}),
  })
  announce({ ...conv }, null)
  return out
}

/** "Talk to our team": the same conversation goes to the staff inbox. */
export async function handOver(id: string, clientUserId: string): Promise<ConversationRow> {
  const conv = await requireOwn(id, clientUserId)
  if (conv.status !== 'assistant') return conv
  const now = new Date().toISOString()
  // Guarded: a double tap hands over once.
  const { data, error } = await supabase.from('support_conversations')
    .update({ status: 'waiting', handed_over_at: now, updated_at: now })
    .eq('conversation_id', id).eq('status', 'assistant').select('*')
  if (error) throw error
  if (!data?.length) return getConversation(id)
  const fresh = data[0] as ConversationRow
  await systemLine(fresh, 'handover',
    'Passed to our team. An Operations Manager or Company Administrator will reply here, and by email if you are away. ' +
    'Booking changes are made in Booking, not in this chat.')
  await afterHoursNotice(fresh)
  logEvent({ user_id: clientUserId, log_type: 'user_activity', action: 'support_chat_handed_over',
    description: `Client asked for our team in conversation ${conversationRef(fresh.conversation_number)}` })
  const lastQuestion = (await messagesOf(id)).filter((m) => m.author === 'client').pop()?.content ?? fresh.title
  void alertTeam(fresh, lastQuestion, true)
  return fresh
}

/**
 * A client writes to the team (chat or an emailed reply). Reopens a resolved
 * conversation within 7 days; after that it is closed for good.
 */
export async function clientMessage(
  id: string, clientUserId: string,
  body: { content: string; attachment_url?: string | null; attachment_stamped?: boolean },
  via: 'chat' | 'email' = 'chat', emailId?: string,
): Promise<MessageRow> {
  const conv = await requireOwn(id, clientUserId)
  if (conv.status === 'assistant' || (conv.status === 'resolved' && !conv.handed_over_at)) {
    throw err('Ask the assistant, or tap "Talk to our team" first', 409)
  }
  if (conv.status === 'resolved' && conv.resolved_at &&
      Date.now() - new Date(conv.resolved_at).getTime() > REOPEN_DAYS * 86_400_000) {
    throw err('This conversation is closed. Start a new one from Messages', 409)
  }
  const m = await insertMessage({
    conversation_id: id, author: 'client', author_id: clientUserId,
    content: body.content.slice(0, 4000), attachment_url: body.attachment_url ?? null,
    attachment_stamped: !!body.attachment_stamped, via, ...(emailId ? { email_id: emailId } : {}),
  })
  const reopened = conv.status === 'resolved'
  const now = new Date().toISOString()
  await update(id, {
    status: 'waiting', last_message_at: now, last_client_message_at: now,
    ...(reopened ? { resolved_at: null, resolved_by: null, resolved_reason: null } : {}),
  })
  announce(conv, m)
  if (reopened) await systemLine(conv, 'reopened', 'The client wrote again, so this conversation is open again.')
  const fresh = { ...conv, status: 'waiting' as const }
  await afterHoursNotice(fresh)
  void alertTeam(fresh, body.content || 'Photo', false)
  return m
}

/** An Operations Manager or Company Administrator replies. */
export async function staffReply(
  id: string, staffId: string,
  body: { content: string; attachment_url?: string | null; attachment_stamped?: boolean },
  opts: { lastSeenMessageId?: string | null; force?: boolean } = {},
): Promise<MessageRow> {
  const conv = await getConversation(id)
  if (conv.status === 'assistant') throw err('The client is still with the assistant; this conversation was not passed to the team', 409)

  // Owned by a colleague who is still active: take it over first.
  if (conv.assigned_to && conv.assigned_to !== staffId) {
    const team = await activeTeamIds()
    if (team.includes(conv.assigned_to)) {
      const owner = await push.getDisplayName(conv.assigned_to)
      throw Object.assign(err(`${owner} is handling this conversation. Take it over to reply.`, 409), { code: 'assigned' })
    }
  }

  // A colleague replied after the last message this person saw: confirm first.
  if (!opts.force && opts.lastSeenMessageId) {
    const { data: seen } = await supabase.from('support_messages').select('created_at').eq('message_id', opts.lastSeenMessageId).eq('conversation_id', id).maybeSingle()
    if (seen) {
      const { data: newer } = await supabase.from('support_messages').select('author_id, created_at')
        .eq('conversation_id', id).eq('author', 'staff').neq('author_id', staffId)
        .gt('created_at', (seen as any).created_at).order('created_at', { ascending: false }).limit(1)
      if (newer?.length) {
        const who = await push.getDisplayName((newer[0] as any).author_id)
        throw Object.assign(err(`${who} replied while you were writing. Read it, then send yours if it still helps.`, 409), { code: 'updated' })
      }
    }
  }
  const m = await insertMessage({
    conversation_id: id, author: 'staff', author_id: staffId,
    content: body.content.slice(0, 4000), attachment_url: body.attachment_url ?? null, attachment_stamped: !!body.attachment_stamped,
  })
  const now = new Date().toISOString()
  await update(id, {
    status: 'replied', last_message_at: now, last_staff_message_at: now, last_staff_replier_id: staffId,
    // The first reply makes them the owner (also after the old owner left).
    ...(conv.assigned_to !== staffId ? { assigned_to: staffId, assigned_at: now } : {}),
    ...(conv.status === 'resolved' ? { resolved_at: null, resolved_by: null, resolved_reason: null } : {}),
  })
  announce(conv, m)
  // The staff member has read everything up to their own reply.
  await supabase.from('support_conversation_reads')
    .upsert({ conversation_id: id, user_id: staffId, last_read_at: now }, { onConflict: 'conversation_id,user_id' })
  const name = await push.getDisplayName(staffId)
  void notify([conv.client_user_id], 'support.chat_replied', `${name} from 8338 Team`, push.preview(body.content || 'Photo'),
    () => ({ conversation_id: id, action_url: '/client/dashboard?chat=messages' }))
  return m
}

/** "Take over": the conversation becomes this staff member's; the old owner is told. */
export async function takeOver(id: string, staffId: string): Promise<ConversationRow> {
  const conv = await getConversation(id)
  if (conv.assigned_to === staffId) return conv
  const now = new Date().toISOString()
  // Guarded on the owner we saw, so two people taking over at once don't both win.
  const base = supabase.from('support_conversations').update({ assigned_to: staffId, assigned_at: now, updated_at: now }).eq('conversation_id', id)
  const { data, error } = await (conv.assigned_to ? base.eq('assigned_to', conv.assigned_to) : base.is('assigned_to', null)).select('*')
  if (error) throw error
  if (!data?.length) throw err('Someone else just took this conversation. Reload it.', 409)
  const fresh = data[0] as ConversationRow
  const name = await push.getDisplayName(staffId)
  logEvent({ user_id: staffId, log_type: 'admin_activity', action: 'support_chat_taken_over',
    description: `${name} took over client conversation ${conversationRef(fresh.conversation_number)}` })
  if (conv.assigned_to && conv.assigned_to !== staffId) {
    const paths = await staffPathFor([conv.assigned_to])
    void notify([conv.assigned_to], 'support.chat_taken_over', `${name} took over a conversation`,
      `${conversationRef(fresh.conversation_number)}${fresh.title ? `: ${fresh.title}` : ''}`,
      (uid) => ({ conversation_id: id, action_url: paths[uid] ?? '/admin/support-tickets?tab=conversations' }))
  }
  void broadcast(`support:conv:${id}`, 'assigned', { assigned_to: staffId, name })
  return fresh
}

/** Staff resolve it, or it resolves itself (scheduler). */
export async function resolve(id: string, staffId: string | null, autoLine?: string): Promise<ConversationRow> {
  const conv = await getConversation(id)
  if (conv.status === 'resolved') return conv
  const now = new Date().toISOString()
  const { data, error } = await supabase.from('support_conversations')
    .update({ status: 'resolved', resolved_at: now, resolved_by: staffId, resolved_reason: staffId ? 'staff' : 'auto', updated_at: now })
    .eq('conversation_id', id).neq('status', 'resolved').select('*')
  if (error) throw error
  if (!data?.length) return getConversation(id)
  const fresh = data[0] as ConversationRow
  await systemLine(fresh, 'resolved', staffId
    ? `Marked resolved by our team. Write here within ${REOPEN_DAYS} days to open it again.`
    : autoLine ?? `Closed after ${AUTO_RESOLVE_DAYS} days with no reply. Write here within ${REOPEN_DAYS} days to open it again.`)
  if (staffId) {
    logEvent({ user_id: staffId, log_type: 'admin_activity', action: 'support_chat_resolved',
      description: `Resolved client conversation ${conversationRef(fresh.conversation_number)}` })
    void notify([fresh.client_user_id], 'support.chat_resolved', 'Your conversation was resolved',
      fresh.title || 'Our team marked your conversation resolved.',
      () => ({ conversation_id: id, action_url: '/client/dashboard?chat=messages' }))
  }
  return fresh
}

// ── Scheduler: auto-resolve + missed-reply emails ───────────────────────────

/**
 * The closing timers: assistant-only chats quiet 24 h close; team-replied
 * chats get one reminder at 3 quiet days and close at 7 (only after the
 * reminder went out). Returns how many closed / were reminded.
 */
export async function autoResolveQuiet(): Promise<number> {
  const day = 86_400_000
  let n = 0

  // 1. Only the assistant answered and the client went quiet for 24 hours.
  const aiCutoff = new Date(Date.now() - ASSISTANT_CLOSE_HOURS * 3_600_000).toISOString()
  const { data: ai, error: aiErr } = await supabase.from('support_conversations')
    .select('conversation_id').eq('status', 'assistant').lt('last_message_at', aiCutoff).limit(200)
  if (aiErr) throw aiErr
  for (const c of (ai ?? []) as any[]) {
    await resolve(c.conversation_id, null,
      `Closed after ${ASSISTANT_CLOSE_HOURS} hours with no new question. Ask here again within ${REOPEN_DAYS} days to carry on.`)
    n++
  }

  // 2. The team replied and the client went quiet.
  const remindCutoff = new Date(Date.now() - REMIND_AFTER_DAYS * day).toISOString()
  const { data: quiet, error } = await supabase.from('support_conversations')
    .select('*').eq('status', 'replied').lt('last_staff_message_at', remindCutoff).limit(200)
  if (error) throw error
  for (const c of (quiet ?? []) as ConversationRow[]) {
    if (c.last_client_message_at && c.last_client_message_at > (c.last_staff_message_at ?? '')) continue
    const reminded = !!c.reminded_at && c.reminded_at >= (c.last_staff_message_at ?? '')
    const closeAt  = new Date(new Date(c.last_staff_message_at!).getTime() + AUTO_RESOLVE_DAYS * day)
    if (!reminded) {
      if (await remind(c, closeAt)) n++
    } else if (Date.now() >= closeAt.getTime()) {
      await resolve(c.conversation_id, null)
      n++
    }
  }
  return n
}

/** The 3-day "did this solve it?" reminder: a line in the chat, a bell, an email. Once per staff reply. */
async function remind(conv: ConversationRow, closeAt: Date): Promise<boolean> {
  const now = new Date().toISOString()
  const base = supabase.from('support_conversations').update({ reminded_at: now }).eq('conversation_id', conv.conversation_id)
  const { data: claimed } = await (conv.reminded_at ? base.eq('reminded_at', conv.reminded_at) : base.is('reminded_at', null)).select('conversation_id')
  if (!claimed?.length) return false
  const when = closeAt.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric' })
  await systemLine(conv, 'reminder', `Did our reply solve it? Write here if you still need help. If we don't hear from you, this conversation closes on ${when}.`)
  void notify([conv.client_user_id], 'support.chat_replied', 'Did our reply solve it?',
    `${conv.title ? `${conv.title}: ` : ''}reply in Messages, or it closes on ${when}.`,
    () => ({ conversation_id: conv.conversation_id, action_url: '/client/dashboard?chat=messages' }))
  try {
    const { data: u } = await supabase.from('users').select('first_name, last_name, email, status').eq('user_id', conv.client_user_id).maybeSingle()
    const c: any = u
    if (c?.email && c.status !== 'archived') {
      await sendConversationReminderEmail({
        reference: conversationRef(conv.conversation_number), title: conv.title,
        clientName: personName(c) || 'there', clientEmail: c.email, closesOn: when,
      })
    }
  } catch (e: any) {
    logSystem({ log_level: 'error', event_type: 'email_event', source: 'support-chat.scheduler',
      message: `Could not email the reminder on ${conversationRef(conv.conversation_number)}: ${e?.message ?? e}` })
  }
  return true
}

/**
 * Email staff replies the client hasn't read within 15 minutes: one email per
 * unread burst (emailed_at remembers), with every unread staff reply in it.
 */
export async function emailMissedReplies(): Promise<number> {
  const cutoff = new Date(Date.now() - EMAIL_AFTER_MIN * 60_000).toISOString()
  const { data, error } = await supabase.from('support_conversations')
    .select('*').in('status', ['replied', 'resolved']).lt('last_staff_message_at', cutoff)
    .gt('last_staff_message_at', new Date(Date.now() - 2 * 86_400_000).toISOString()).limit(200)
  if (error) throw error
  let sent = 0
  for (const conv of (data ?? []) as ConversationRow[]) {
    if (conv.emailed_at && conv.emailed_at >= (conv.last_staff_message_at ?? '')) continue
    const reads = await readAt([conv.conversation_id], conv.client_user_id)
    const seen  = reads[conv.conversation_id]
    if (seen && seen >= (conv.last_staff_message_at ?? '')) continue
    // Claim first, so two server instances email once.
    const { data: claimed } = await (conv.emailed_at
      ? supabase.from('support_conversations').update({ emailed_at: new Date().toISOString() }).eq('conversation_id', conv.conversation_id).eq('emailed_at', conv.emailed_at)
      : supabase.from('support_conversations').update({ emailed_at: new Date().toISOString() }).eq('conversation_id', conv.conversation_id).is('emailed_at', null)
    ).select('conversation_id')
    if (!claimed?.length) continue

    const since    = [seen, conv.emailed_at].filter(Boolean).sort().pop() ?? '1970-01-01'
    const messages = (await messagesOf(conv.conversation_id)).filter((m) => m.author === 'staff' && m.created_at > since)
    if (!messages.length) continue
    const authors = await authorsOf(messages)
    const { data: client } = await supabase.from('users').select('first_name, last_name, email, status').eq('user_id', conv.client_user_id).maybeSingle()
    const c: any = client
    if (!c?.email || c.status === 'archived') continue
    try {
      await sendConversationReplyEmail({
        reference:   conversationRef(conv.conversation_number),
        title:       conv.title,
        clientName:  personName(c) || 'there',
        clientEmail: c.email,
        replies:     messages.map((m) => {
          const a = authors[m.author_id ?? '']
          return { name: a ? `${a.name} (${ROLE_LABEL[a.role] ?? 'Our team'})` : 'Our team', text: m.content }
        }),
      })
      sent++
    } catch (e: any) {
      logSystem({ log_level: 'error', event_type: 'email_event', source: 'support-chat.scheduler',
        message: `Could not email the missed reply on ${conversationRef(conv.conversation_number)}: ${e?.message ?? e}` })
    }
  }
  return sent
}

// ── Email replies (Resend inbound, via ticket-replies.service) ───────────────

/**
 * An email reply to a conversation email: from the client's account address
 * (DMARC not failing) it is added as their message, marked "via email".
 * Anything else is not added (logged). Returns whether it was recorded.
 */
export async function recordEmailReply(p: {
  number: number; senderEmail: string; dmarcFailed: boolean; body: string; emailId: string
}): Promise<'added' | 'not_client' | 'closed' | 'missing' | 'duplicate'> {
  const { data: conv } = await supabase.from('support_conversations').select('*').eq('conversation_number', p.number).maybeSingle()
  if (!conv) return 'missing'
  const c = conv as ConversationRow
  const { data: seen } = await supabase.from('support_messages').select('message_id').eq('email_id', p.emailId).maybeSingle()
  if (seen) return 'duplicate'
  const { data: user } = await supabase.from('users').select('email').eq('user_id', c.client_user_id).maybeSingle()
  const clientEmail = String((user as any)?.email ?? '').trim().toLowerCase()
  if (!clientEmail || clientEmail !== p.senderEmail || p.dmarcFailed) return 'not_client'
  try {
    await clientMessage(c.conversation_id, c.client_user_id, { content: p.body || '(empty email)' }, 'email', p.emailId)
    return 'added'
  } catch (e: any) {
    if (e?.code === '23505') return 'duplicate'
    if (e?.statusCode === 409) return 'closed'
    throw e
  }
}
