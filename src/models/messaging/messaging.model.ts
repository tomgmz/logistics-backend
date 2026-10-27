import { supabase } from '../../lib/supabase.js'
import type {
  ConversationRow,
  ConversationWithDetails,
  MessageRow,
  MessagableUser,
  UserRole,
  BookingRefRow,
} from '../../types/messaging.types.js'
import type { MessageBodyColumns } from '../../services/messaging/photo.service.js'

export async function findConversationByParticipants(a: string, b: string): Promise<ConversationRow | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .or(`and(participant_a_id.eq.${a},participant_b_id.eq.${b}),and(participant_a_id.eq.${b},participant_b_id.eq.${a})`)
    .maybeSingle()
  if (error) throw error
  return data as ConversationRow | null
}

export async function createConversation(
  participantAId: string,
  participantBId: string,
  contextType: 'direct' | 'booking_transit',
  bookingId?: string
): Promise<ConversationRow> {
  const { data, error } = await supabase
    .from('conversations')
    .insert({ participant_a_id: participantAId, participant_b_id: participantBId, context_type: contextType, booking_id: bookingId ?? null })
    .select()
    .single()
  if (error) throw error
  return data as ConversationRow
}

export async function findConversationById(id: string): Promise<ConversationRow | null> {
  const { data, error } = await supabase.from('conversations').select('*').eq('conversation_id', id).maybeSingle()
  if (error) throw error
  return data as ConversationRow | null
}

const toMs = (iso: string) => new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).getTime()

export async function getConversationsByUserId(userId: string): Promise<ConversationWithDetails[]> {
  const { data: convRaw, error: convErr } = await supabase
    .from('conversations')
    .select('*')
    .or(`participant_a_id.eq.${userId},participant_b_id.eq.${userId}`)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (convErr) throw convErr
  if (!convRaw?.length) return []

  const convs = convRaw as ConversationRow[]
  const ids   = convs.map(c => c.conversation_id)
  const other = convs.map(c => c.participant_a_id === userId ? c.participant_b_id : c.participant_a_id)

  const bookingIds = [...new Set(convs.map(c => c.booking_id).filter((id): id is string => !!id))]

  const [{ data: usersRaw, error: userErr }, { data: msgsRaw, error: msgErr }, { data: bookingsRaw, error: bookingErr }] =
    await Promise.all([
      supabase.from('users').select('user_id, first_name, last_name, role, email').in('user_id', other),
      supabase.from('messages')
        .select('conversation_id, message_id, content, sent_at, sender_id, deleted_by_sender, deleted_by_receiver')
        .in('conversation_id', ids)
        .order('sent_at', { ascending: false }),
      bookingIds.length
        ? supabase.from('bookings').select('booking_id, reference_number').in('booking_id', bookingIds)
        : Promise.resolve({ data: [] as BookingRefRow[], error: null }),
    ])
  if (userErr) throw userErr
  if (msgErr) throw msgErr
  if (bookingErr) throw bookingErr
  const bookingMap = new Map(((bookingsRaw ?? []) as BookingRefRow[]).map(b => [b.booking_id, b]))

  type UserRow = { user_id: string; first_name: string | null; last_name: string | null; role: UserRole; email: string }
  const userMap = Object.fromEntries((usersRaw ?? []).map((u: UserRow) => [u.user_id, u]))
  const convMap = Object.fromEntries(convs.map(c => [c.conversation_id, c]))

  const lastMsgMap: Record<string, { message_id: string; content: string; sent_at: string; sender_id: string }> = {}
  const unreadMap:  Record<string, number> = {}

  type MsgRow = { conversation_id: string; message_id: string; content: string; sent_at: string; sender_id: string; deleted_by_sender: boolean; deleted_by_receiver: boolean }
  for (const m of (msgsRaw ?? []) as MsgRow[]) {
    const deletedForMe = m.sender_id === userId ? m.deleted_by_sender : m.deleted_by_receiver
    if (deletedForMe) continue

    if (!lastMsgMap[m.conversation_id]) lastMsgMap[m.conversation_id] = m

    if (m.sender_id === userId) continue
    const conv         = convMap[m.conversation_id]
    const myLastReadAt = conv.participant_a_id === userId
      ? conv.participant_a_last_read_at
      : conv.participant_b_last_read_at
    if (myLastReadAt === null || toMs(m.sent_at) > toMs(myLastReadAt))
      unreadMap[m.conversation_id] = (unreadMap[m.conversation_id] ?? 0) + 1
  }

  return convs.reduce<ConversationWithDetails[]>((acc, c) => {
    const otherId = c.participant_a_id === userId ? c.participant_b_id : c.participant_a_id
    const user    = userMap[otherId] as UserRow | undefined
    if (!user) return acc
    acc.push({ ...c, other_user: user, booking: (c.booking_id && bookingMap.get(c.booking_id)) || null, last_message: lastMsgMap[c.conversation_id] ?? null, unread_count: unreadMap[c.conversation_id] ?? 0 })
    return acc
  }, [])
}

export async function getMessagesByConversationId(
  conversationId: string,
  userId: string,
  limit: number,
  before?: string
): Promise<MessageRow[]> {
  let q = supabase
    .from('messages')
    .select('*, reactions:message_reactions(emoji, user_id)')
    .eq('conversation_id', conversationId)
    .or(`and(sender_id.eq.${userId},deleted_by_sender.eq.false),and(receiver_id.eq.${userId},deleted_by_receiver.eq.false)`)
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (before) q = q.lt('sent_at', before)
  const { data, error } = await q
  if (error) throw error

  const msgs = ((data ?? []) as unknown as MessageRow[]).reverse()

  const replyIds = [...new Set(
    msgs.map(m => m.reply_to_message_id).filter((id): id is string => !!id)
  )]

  type ReplySnippet = { message_id: string; content: string; sender_id: string }
  const replyMap: Record<string, ReplySnippet> = {}

  if (replyIds.length > 0) {
    const { data: replyRows } = await supabase
      .from('messages')
      .select('message_id, content, sender_id')
      .in('message_id', replyIds)
    for (const r of (replyRows ?? []) as ReplySnippet[]) {
      replyMap[r.message_id] = r
    }
  }

  return msgs.map(m => ({
    ...m,
    reply_to:  m.reply_to_message_id ? (replyMap[m.reply_to_message_id] ?? null) : null,
    reactions: Array.isArray(m.reactions) ? m.reactions : [],
  }))
}

export async function insertMessage(
  conversationId: string,
  senderId: string,
  receiverId: string,
  body: MessageBodyColumns,
  replyToMessageId?: string
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, receiver_id: receiverId, ...body, reply_to_message_id: replyToMessageId ?? null })
    .select()
    .single()
  if (error) throw error
  return data as MessageRow
}

export async function touchConversation(id: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase.from('conversations').update({ last_message_at: now, updated_at: now }).eq('conversation_id', id)
  if (error) throw error
}

export async function markMessagesRead(conversationId: string, userId: string): Promise<string> {
  const [{ data: conv, error: convErr }, { data: latest, error: latestErr }] = await Promise.all([
    supabase.from('conversations').select('participant_a_id').eq('conversation_id', conversationId).single(),
    supabase.from('messages')
      .select('sent_at')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  if (convErr) throw convErr
  if (latestErr) throw latestErr

  const readAt = (latest as { sent_at: string } | null)?.sent_at ?? new Date().toISOString()

  const col = (conv as { participant_a_id: string }).participant_a_id === userId
    ? 'participant_a_last_read_at'
    : 'participant_b_last_read_at'

  const { error } = await supabase
    .from('conversations')
    .update({ [col]: readAt })
    .eq('conversation_id', conversationId)
  if (error) throw error
  return readAt
}

/**
 * What `receiverId` hasn't read yet from the other side of a conversation,
 * oldest first — the latest `limit` of them plus the total. Feeds the stacked
 * push notification.
 */
export async function getUnreadForPush(
  conversationId: string,
  receiverId: string,
  limit: number,
): Promise<{ contents: string[]; total: number }> {
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('participant_a_id, participant_a_last_read_at, participant_b_last_read_at')
    .eq('conversation_id', conversationId)
    .single()
  if (convErr) throw convErr
  const c = conv as { participant_a_id: string; participant_a_last_read_at: string | null; participant_b_last_read_at: string | null }
  const readAt = c.participant_a_id === receiverId ? c.participant_a_last_read_at : c.participant_b_last_read_at

  let q = supabase
    .from('messages')
    .select('content', { count: 'exact' })
    .eq('conversation_id', conversationId)
    .eq('receiver_id', receiverId)
    .eq('deleted_by_receiver', false)
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (readAt) q = q.gt('sent_at', readAt)

  const { data, count, error } = await q
  if (error) throw error
  const contents = ((data ?? []) as { content: string }[]).map((m) => m.content).reverse()
  return { contents, total: count ?? contents.length }
}

export async function findMessageById(id: string): Promise<MessageRow | null> {
  const { data, error } = await supabase.from('messages').select('*').eq('message_id', id).maybeSingle()
  if (error) throw error
  return data as MessageRow | null
}

/** Unsend: the sender takes the message back from both sides of the conversation. */
export async function unsendMessage(messageId: string, senderId: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ deleted_by_sender: true, deleted_by_receiver: true })
    .eq('message_id', messageId)
    .eq('sender_id', senderId)
  if (error) throw error
}

export async function softDeleteMessage(messageId: string, userId: string, asSender: boolean): Promise<void> {
  const field = asSender ? 'deleted_by_sender' : 'deleted_by_receiver'
  const owner = asSender ? 'sender_id' : 'receiver_id'
  const { error } = await supabase.from('messages').update({ [field]: true }).eq('message_id', messageId).eq(owner, userId)
  if (error) throw error
}

export async function toggleMessageReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<{ action: 'added' | 'removed' }> {
  const { data: existing } = await supabase
    .from('message_reactions').select('id, emoji').eq('message_id', messageId).eq('user_id', userId).maybeSingle()

  if (existing) {
    const row = existing as { id: string; emoji: string }
    if (row.emoji === emoji) {
      await supabase.from('message_reactions').delete().eq('id', row.id)
      return { action: 'removed' }
    }
    await supabase.from('message_reactions').update({ emoji }).eq('id', row.id)
    return { action: 'added' }
  }

  await supabase.from('message_reactions').insert({ message_id: messageId, user_id: userId, emoji })
  return { action: 'added' }
}

export async function findTargetUser(id: string): Promise<{ user_id: string; status: string; role: string } | null> {
  const { data, error } = await supabase.from('users').select('user_id, status, role').eq('user_id', id).maybeSingle()
  if (error) throw error
  return data as { user_id: string; status: string; role: string } | null
}

// Who may talk to a client:
//   - Company Administrator and Operations Manager: any active client, any time.
//   - Drivers: never, in either direction (turned off 2026-10-27).
//   - Everyone else on staff: never.
// A client may not send to anyone; staff messages reach them read-only.
export const CLIENT_MESSAGING_STAFF_ROLES = ['admin', 'operations_manager']

/**
 * Whether sender may send to target, by the rules above. Returns the reason
 * when not. Reading an existing conversation is never blocked by this.
 */
export async function messagingBlockReason(
  sender: { user_id: string; role: string },
  target: { user_id: string; role: string }
): Promise<string | null> {
  if (sender.role === 'client') {
    return target.role === 'driver'
      ? 'Drivers and clients cannot message each other'
      : 'Clients cannot send messages'
  }
  if (target.role === 'client') {
    if (CLIENT_MESSAGING_STAFF_ROLES.includes(sender.role)) return null
    if (sender.role === 'driver') return 'Drivers and clients cannot message each other'
    return 'Only the Company Administrator and Operations Manager can message clients'
  }
  return null
}

async function activeUsers(opts: { ids?: string[]; withoutClients?: boolean } = {}): Promise<MessagableUser[]> {
  let q = supabase.from('users').select('user_id, first_name, last_name, role, email').eq('status', 'active').order('first_name')
  if (opts.ids) q = q.in('user_id', opts.ids)
  if (opts.withoutClients) q = q.neq('role', 'client')
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as MessagableUser[]
}

export async function getMessagableUsersForStaff(currentUserId: string, role: string): Promise<MessagableUser[]> {
  const users = await activeUsers({ withoutClients: !CLIENT_MESSAGING_STAFF_ROLES.includes(role) })
  return users.filter(u => u.user_id !== currentUserId)
}

/** A driver: everyone on staff, never a client. */
export async function getMessagableUsersForDriver(driverUserId: string): Promise<MessagableUser[]> {
  const staff = await activeUsers({ withoutClients: true })
  return staff.filter(u => u.user_id !== driverUserId)
}
