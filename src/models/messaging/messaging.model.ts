import { supabase } from '../../lib/supabase.js'
import type {
  ConversationRow,
  ConversationWithDetails,
  MessageRow,
  MessagableUser,
  UserRole,
} from '../../types/messaging.types.js'

// ─── Conversations ─────────────────────────────────────────────────────────────

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

  const [{ data: usersRaw, error: userErr }, { data: msgsRaw, error: msgErr }, { data: unreadRaw, error: unreadErr }] =
    await Promise.all([
      supabase.from('users').select('user_id, first_name, last_name, role, email').in('user_id', other),
      supabase.from('messages').select('conversation_id, message_id, content, sent_at, sender_id').in('conversation_id', ids).order('sent_at', { ascending: false }),
      supabase.from('messages').select('conversation_id').in('conversation_id', ids).eq('receiver_id', userId).eq('is_read', false).eq('deleted_by_receiver', false),
    ])
  if (userErr) throw userErr
  if (msgErr) throw msgErr
  if (unreadErr) throw unreadErr

  type UserRow = { user_id: string; first_name: string | null; last_name: string | null; role: UserRole; email: string }
  const userMap   = Object.fromEntries((usersRaw ?? []).map((u: UserRow) => [u.user_id, u]))
  const lastMsgMap: Record<string, { message_id: string; content: string; sent_at: string; sender_id: string }> = {}
  for (const m of msgsRaw ?? []) {
    const row = m as { conversation_id: string; message_id: string; content: string; sent_at: string; sender_id: string }
    if (!lastMsgMap[row.conversation_id]) lastMsgMap[row.conversation_id] = row
  }
  const unreadMap: Record<string, number> = {}
  for (const r of (unreadRaw ?? []) as { conversation_id: string }[]) {
    unreadMap[r.conversation_id] = (unreadMap[r.conversation_id] ?? 0) + 1
  }

  return convs.reduce<ConversationWithDetails[]>((acc, c) => {
    const otherId = c.participant_a_id === userId ? c.participant_b_id : c.participant_a_id
    const user    = userMap[otherId] as UserRow | undefined
    if (!user) return acc
    acc.push({ ...c, other_user: user, last_message: lastMsgMap[c.conversation_id] ?? null, unread_count: unreadMap[c.conversation_id] ?? 0 })
    return acc
  }, [])
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function getMessagesByConversationId(
  conversationId: string,
  userId: string,
  limit: number,
  before?: string
): Promise<MessageRow[]> {
  let q = supabase
    .from('messages')
    .select('*, reply_to:messages!reply_to_message_id(message_id, content, sender_id), reactions:message_reactions(emoji, user_id)')
    .eq('conversation_id', conversationId)
    .or(`and(sender_id.eq.${userId},deleted_by_sender.eq.false),and(receiver_id.eq.${userId},deleted_by_receiver.eq.false)`)
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (before) q = q.lt('sent_at', before)
  const { data, error } = await q
  if (error) throw error
  return ((data ?? []) as unknown as MessageRow[]).reverse()
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

export async function markMessagesRead(conversationId: string, receiverId: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('receiver_id', receiverId)
    .eq('is_read', false)
  if (error) throw error
}

export async function findMessageById(id: string): Promise<MessageRow | null> {
  const { data, error } = await supabase.from('messages').select('*').eq('message_id', id).maybeSingle()
  if (error) throw error
  return data as MessageRow | null
}

export async function softDeleteMessage(messageId: string, userId: string, asSender: boolean): Promise<void> {
  const field = asSender ? 'deleted_by_sender' : 'deleted_by_receiver'
  const owner = asSender ? 'sender_id' : 'receiver_id'
  const { error } = await supabase.from('messages').update({ [field]: true }).eq('message_id', messageId).eq(owner, userId)
  if (error) throw error
}

// ─── Reactions ────────────────────────────────────────────────────────────────
// UNIQUE(message_id, user_id): one reaction per user per message.
// Same emoji → remove. Different emoji → replace. None → insert.

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

// ─── Users ─────────────────────────────────────────────────────────────────────

export async function findTargetUser(id: string): Promise<{ user_id: string; status: string; role: string } | null> {
  const { data, error } = await supabase.from('users').select('user_id, status, role').eq('user_id', id).maybeSingle()
  if (error) throw error
  return data as { user_id: string; status: string; role: string } | null
}

export async function getMessagableUsersForStaff(currentUserId: string): Promise<MessagableUser[]> {
  const { data, error } = await supabase
    .from('users').select('user_id, first_name, last_name, role, email')
    .neq('user_id', currentUserId).eq('status', 'active').order('first_name')
  if (error) throw error
  return (data ?? []) as MessagableUser[]
}

export async function getMessagableDriversForClient(clientUserId: string): Promise<MessagableUser[]> {
  const { data: client } = await supabase.from('clients').select('client_id').eq('user_id', clientUserId).maybeSingle()
  if (!client) return []

  const { data: bookings } = await supabase.from('bookings').select('booking_id').eq('client_id', (client as { client_id: string }).client_id).eq('status', 'in_transit')
  if (!bookings?.length) return []
  const bookingIds = (bookings as { booking_id: string }[]).map(b => b.booking_id)

  const { data: assignments } = await supabase
    .from('driver_assignments').select('booking_id, drivers!inner(driver_id, user_id)').in('booking_id', bookingIds)
  if (!assignments?.length) return []

  type Assignment = { booking_id: string; drivers: { driver_id: string; user_id: string }[] }
  const typed       = assignments as unknown as Assignment[]
  const driverIds   = [...new Set(typed.flatMap(a => a.drivers.map(d => d.user_id)))]

  const { data: users } = await supabase
    .from('users').select('user_id, first_name, last_name, role, email').in('user_id', driverIds).eq('status', 'active')

  return (users ?? []).map((u: Record<string, unknown>) => ({
    ...(u as unknown as MessagableUser),
    booking_id: typed.find(a => a.drivers.some(d => d.user_id === u.user_id))?.booking_id,
  }))
}

export async function validateClientDriverAccess(clientUserId: string, targetUserId: string): Promise<boolean> {
  const [{ data: client }, { data: driver }] = await Promise.all([
    supabase.from('clients').select('client_id').eq('user_id', clientUserId).maybeSingle(),
    supabase.from('drivers').select('driver_id').eq('user_id', targetUserId).maybeSingle(),
  ])
  if (!client || !driver) return false

  const { data: bookings } = await supabase.from('bookings').select('booking_id')
    .eq('client_id', (client as { client_id: string }).client_id).eq('status', 'in_transit')
  if (!bookings?.length) return false

  const { count } = await supabase.from('driver_assignments')
    .select('assignment_id', { count: 'exact', head: true })
    .eq('driver_id', (driver as { driver_id: string }).driver_id)
    .in('booking_id', (bookings as { booking_id: string }[]).map(b => b.booking_id))
  return (count ?? 0) > 0
}