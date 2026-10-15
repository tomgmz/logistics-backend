import { supabase } from '../../lib/supabase.js'
import type {
  ConversationRow,
  ConversationWithDetails,
  MessageRow,
  MessagableUser,
  UserRole,
  BookingRefRow,
} from '../../types/messaging.types.js'

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
  content: string,
  replyToMessageId?: string
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, receiver_id: receiverId, content, reply_to_message_id: replyToMessageId ?? null })
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

// Who may talk to a client, and for how long:
//   - Company Administrator and Operations Manager: any active client, any time.
//   - A driver: only while crew (main or second driver) on one of that client's
//     open bookings, from assignment until the client confirms completion (or
//     it auto-completes). 'delivered' stays open so the client can still reach
//     the driver about the drop-off before confirming.
//   - Everyone else on staff: never.
// A client may only send to such a driver; staff messages reach them read-only.
export const CLIENT_CHAT_BOOKING_STATUSES = ['assigned', 'in_transit', 'delivered']
export const CLIENT_MESSAGING_STAFF_ROLES = ['admin', 'operations_manager']

type ClientDriverLink = { client_user_id: string; driver_user_id: string; booking_id: string; reference_number: string | null }

/** Every (client, driver, booking) link on open bookings, narrowed to one client and/or one driver. */
async function openClientDriverLinks(filter: { clientUserId?: string; driverUserId?: string }): Promise<ClientDriverLink[]> {
  let bq = supabase.from('bookings').select('booking_id, reference_number, clients!inner(user_id)').in('status', CLIENT_CHAT_BOOKING_STATUSES)
  if (filter.clientUserId) bq = bq.eq('clients.user_id', filter.clientUserId)
  const { data: bookings, error: bErr } = await bq
  if (bErr) throw bErr
  if (!bookings?.length) return []

  type BookingRow = { booking_id: string; reference_number: string | null; clients: { user_id: string } | { user_id: string }[] }
  const clientOf = new Map<string, string>()
  const refOf    = new Map<string, string | null>()
  for (const b of bookings as unknown as BookingRow[]) {
    const c = Array.isArray(b.clients) ? b.clients[0] : b.clients
    if (c?.user_id) clientOf.set(b.booking_id, c.user_id)
    refOf.set(b.booking_id, b.reference_number)
  }
  if (!clientOf.size) return []

  let aq = supabase.from('driver_assignments').select('booking_id, drivers!inner(user_id)').in('booking_id', [...clientOf.keys()])
  if (filter.driverUserId) aq = aq.eq('drivers.user_id', filter.driverUserId)
  const { data: assignments, error: aErr } = await aq
  if (aErr) throw aErr

  type AssignmentRow = { booking_id: string; drivers: { user_id: string } | { user_id: string }[] }
  return ((assignments ?? []) as unknown as AssignmentRow[]).flatMap((a) => {
    const d = Array.isArray(a.drivers) ? a.drivers[0] : a.drivers
    const c = clientOf.get(a.booking_id)
    return d?.user_id && c
      ? [{ client_user_id: c, driver_user_id: d.user_id, booking_id: a.booking_id, reference_number: refOf.get(a.booking_id) ?? null }]
      : []
  })
}

/** The open booking that links this client and driver, if any (the first, when several do). */
export async function currentClientDriverBooking(clientUserId: string, driverUserId: string): Promise<string | null> {
  return (await openClientDriverLinks({ clientUserId, driverUserId }))[0]?.booking_id ?? null
}

export async function setConversationBooking(conversationId: string, bookingId: string): Promise<void> {
  const { error } = await supabase.from('conversations').update({ booking_id: bookingId }).eq('conversation_id', conversationId)
  if (error) throw error
}

/** True while the driver is crew on one of the client's open bookings. */
export async function driverServesClient(driverUserId: string, clientUserId: string): Promise<boolean> {
  return (await openClientDriverLinks({ clientUserId, driverUserId })).length > 0
}

/**
 * Whether sender may send to target, by the rules above. Returns the reason
 * when not. Reading an existing conversation is never blocked by this.
 */
export async function messagingBlockReason(
  sender: { user_id: string; role: string },
  target: { user_id: string; role: string }
): Promise<string | null> {
  if (sender.role === 'client') {
    if (target.role !== 'driver') return 'You can only message the driver of your active delivery'
    return (await driverServesClient(target.user_id, sender.user_id))
      ? null
      : 'You can message this driver only while they are on one of your active deliveries'
  }
  if (target.role === 'client') {
    if (CLIENT_MESSAGING_STAFF_ROLES.includes(sender.role)) return null
    if (sender.role === 'driver') {
      return (await driverServesClient(sender.user_id, target.user_id))
        ? null
        : 'You can message this client only while you are on one of their active deliveries'
    }
    return 'Only the Company Administrator, Operations Manager and assigned drivers can message clients'
  }
  return null
}

/** booking_id (the first, kept for older callers) plus every open booking linking the two. */
function withLinkedBookings(u: MessagableUser, links: ClientDriverLink[]): MessagableUser {
  return {
    ...u,
    booking_id: links[0]?.booking_id,
    bookings:   links.map(l => ({ booking_id: l.booking_id, reference_number: l.reference_number })),
  }
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

/** A driver: everyone on staff, plus the clients of their open bookings. */
export async function getMessagableUsersForDriver(driverUserId: string): Promise<MessagableUser[]> {
  const [staff, links] = await Promise.all([
    activeUsers({ withoutClients: true }),
    openClientDriverLinks({ driverUserId }),
  ])
  const clientIds = [...new Set(links.map(l => l.client_user_id))]
  const clients   = clientIds.length ? await activeUsers({ ids: clientIds }) : []
  return [
    ...staff.filter(u => u.user_id !== driverUserId),
    ...clients.map(u => withLinkedBookings(u, links.filter(l => l.client_user_id === u.user_id))),
  ]
}

/** A client: only the drivers (main and second) on their open bookings. */
export async function getMessagableDriversForClient(clientUserId: string): Promise<MessagableUser[]> {
  const links     = await openClientDriverLinks({ clientUserId })
  const driverIds = [...new Set(links.map(l => l.driver_user_id))]
  if (!driverIds.length) return []
  const users = await activeUsers({ ids: driverIds })
  return users.map(u => withLinkedBookings(u, links.filter(l => l.driver_user_id === u.user_id)))
}
