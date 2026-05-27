import { supabase } from '../../lib/supabase.js'
import type {
  ConversationRow,
  ConversationWithDetails,
  ConversationLastMessage,
  MessageRow,
  MessagableUser,
  UserRole,
} from '../../types/messaging.types.js'

export async function findConversationByParticipants(
  userAId: string,
  userBId: string
): Promise<ConversationRow | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .or(
      `and(participant_a_id.eq.${userAId},participant_b_id.eq.${userBId}),` +
      `and(participant_a_id.eq.${userBId},participant_b_id.eq.${userAId})`
    )
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
    .insert({
      participant_a_id: participantAId,
      participant_b_id: participantBId,
      context_type: contextType,
      booking_id: bookingId ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data as ConversationRow
}

export async function findConversationById(conversationId: string): Promise<ConversationRow | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) throw error
  return data as ConversationRow | null
}

export async function getConversationsByUserId(userId: string): Promise<ConversationWithDetails[]> {
  const { data: conversationsRaw, error: convError } = await supabase
    .from('conversations')
    .select('*')
    .or(`participant_a_id.eq.${userId},participant_b_id.eq.${userId}`)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (convError) throw convError
  if (!conversationsRaw || conversationsRaw.length === 0) return []

  const conversations = conversationsRaw as ConversationRow[]
  const otherUserIds = conversations.map(c =>
    c.participant_a_id === userId ? c.participant_b_id : c.participant_a_id
  )
  const conversationIds = conversations.map(c => c.conversation_id)

  const { data: usersRaw, error: userError } = await supabase
    .from('users')
    .select('user_id, first_name, last_name, role, email')
    .in('user_id', otherUserIds)
  if (userError) throw userError

  type UserRow = { user_id: string; first_name: string | null; last_name: string | null; role: UserRole; email: string }
  const userMap: Record<string, UserRow> = Object.fromEntries(
    (usersRaw ?? []).map((u: UserRow) => [u.user_id, u])
  )

  const { data: allMessagesRaw, error: msgError } = await supabase
    .from('messages')
    .select('conversation_id, message_id, content, sent_at, sender_id')
    .in('conversation_id', conversationIds)
    .order('sent_at', { ascending: false })
  if (msgError) throw msgError

  type MessageWithConvId = ConversationLastMessage & { conversation_id: string }
  const lastMessageMap: Record<string, ConversationLastMessage> = {}
  for (const msg of (allMessagesRaw ?? []) as MessageWithConvId[]) {
    if (!lastMessageMap[msg.conversation_id]) {
      lastMessageMap[msg.conversation_id] = {
        message_id: msg.message_id,
        content: msg.content,
        sent_at: msg.sent_at,
        sender_id: msg.sender_id,
      }
    }
  }

  const { data: unreadRows, error: unreadError } = await supabase
    .from('messages')
    .select('conversation_id')
    .in('conversation_id', conversationIds)
    .eq('receiver_id', userId)
    .eq('is_read', false)
    .eq('deleted_by_receiver', false)
  if (unreadError) throw unreadError

  const unreadMap: Record<string, number> = {}
  for (const row of (unreadRows ?? []) as { conversation_id: string }[]) {
    unreadMap[row.conversation_id] = (unreadMap[row.conversation_id] ?? 0) + 1
  }

  return conversations.reduce<ConversationWithDetails[]>((acc, conv) => {
    const otherUserId = conv.participant_a_id === userId ? conv.participant_b_id : conv.participant_a_id
    const otherUser = userMap[otherUserId]
    if (!otherUser) return acc
    acc.push({
      ...conv,
      other_user: { ...otherUser, role: otherUser.role as UserRole },
      last_message: lastMessageMap[conv.conversation_id] ?? null,
      unread_count: unreadMap[conv.conversation_id] ?? 0,
    })
    return acc
  }, [])
}

export async function getMessagesByConversationId(
  conversationId: string,
  userId: string,
  limit: number,
  before?: string
): Promise<MessageRow[]> {
  let query = supabase
    .from('messages')
    .select(`
      *,
      reply_to:messages!reply_to_message_id(message_id, content, sender_id),
      reactions:message_reactions(emoji, user_id)
    `)
    .eq('conversation_id', conversationId)
    .or(
      `and(sender_id.eq.${userId},deleted_by_sender.eq.false),` +
      `and(receiver_id.eq.${userId},deleted_by_receiver.eq.false)`
    )
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (before) query = query.lt('sent_at', before)
  const { data, error } = await query
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
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      receiver_id: receiverId,
      content,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    })
    .select()
    .single()
  if (error) throw error
  return data as MessageRow
}

export async function touchConversation(conversationId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('conversations')
    .update({ last_message_at: now, updated_at: now })
    .eq('conversation_id', conversationId)
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

export async function findMessageById(messageId: string): Promise<MessageRow | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('message_id', messageId)
    .maybeSingle()
  if (error) throw error
  return data as MessageRow | null
}

export async function softDeleteMessage(messageId: string, userId: string, asSender: boolean): Promise<void> {
  const field = asSender ? 'deleted_by_sender' : 'deleted_by_receiver'
  const ownerField = asSender ? 'sender_id' : 'receiver_id'
  const { error } = await supabase
    .from('messages')
    .update({ [field]: true })
    .eq('message_id', messageId)
    .eq(ownerField, userId)
  if (error) throw error
}

// ─── Reactions ────────────────────────────────────────────────────────────────
//
// UNIQUE(message_id, user_id) — one reaction per user per DM message.
// Toggle logic:
//   • same emoji → remove (toggle off)
//   • different emoji → replace (update in place)
//   • none yet → insert

export async function toggleMessageReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<{ action: 'added' | 'removed' }> {
  const { data: existing } = await supabase
    .from('message_reactions')
    .select('id, emoji')
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    if ((existing as any).emoji === emoji) {
      await supabase.from('message_reactions').delete().eq('id', (existing as any).id)
      return { action: 'removed' }
    }
    // Different emoji → replace
    await supabase
      .from('message_reactions')
      .update({ emoji })
      .eq('id', (existing as any).id)
    return { action: 'added' }
  }

  await supabase.from('message_reactions').insert({ message_id: messageId, user_id: userId, emoji })
  return { action: 'added' }
}

export async function getMessagableUsersForStaff(currentUserId: string): Promise<MessagableUser[]> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, first_name, last_name, role, email')
    .neq('user_id', currentUserId)
    .eq('status', 'active')
    .order('first_name', { ascending: true })
  if (error) throw error
  return (data ?? []) as MessagableUser[]
}

export async function getMessagableDriversForClient(clientUserId: string): Promise<MessagableUser[]> {
  const { data: client, error: clientError } = await supabase
    .from('clients').select('client_id').eq('user_id', clientUserId).maybeSingle()
  if (clientError) throw clientError
  if (!client) return []

  const { data: bookingsRaw, error: bookingError } = await supabase
    .from('bookings').select('booking_id').eq('client_id', (client as any).client_id).eq('status', 'in_transit')
  if (bookingError) throw bookingError
  if (!bookingsRaw || bookingsRaw.length === 0) return []

  const bookingIds = (bookingsRaw as { booking_id: string }[]).map(b => b.booking_id)

  const { data: assignments, error: assignError } = await supabase
    .from('driver_assignments')
    .select('booking_id, drivers!inner(driver_id, user_id)')
    .in('booking_id', bookingIds)
  if (assignError) throw assignError
  if (!assignments || assignments.length === 0) return []

  const typedAssignments = assignments as unknown as { booking_id: string; drivers: { driver_id: string; user_id: string }[] }[]
  const driverUserIds = [...new Set(typedAssignments.flatMap(a => a.drivers.map(d => d.user_id)))]

  const { data: usersRaw, error: userError } = await supabase
    .from('users').select('user_id, first_name, last_name, role, email').in('user_id', driverUserIds).eq('status', 'active')
  if (userError) throw userError

  return (usersRaw ?? []).map((u: any) => ({
    ...u,
    role: u.role as UserRole,
    booking_id: typedAssignments.find(a => a.drivers.some(d => d.user_id === u.user_id))?.booking_id,
  }))
}

export async function validateClientDriverAccess(clientUserId: string, targetUserId: string): Promise<boolean> {
  const { data: client } = await supabase.from('clients').select('client_id').eq('user_id', clientUserId).maybeSingle()
  if (!client) return false
  const { data: driver } = await supabase.from('drivers').select('driver_id').eq('user_id', targetUserId).maybeSingle()
  if (!driver) return false
  const { data: bookingsRaw } = await supabase.from('bookings').select('booking_id').eq('client_id', (client as any).client_id).eq('status', 'in_transit')
  if (!bookingsRaw || bookingsRaw.length === 0) return false
  const bookingIds = (bookingsRaw as { booking_id: string }[]).map(b => b.booking_id)
  const { count } = await supabase
    .from('driver_assignments').select('assignment_id', { count: 'exact', head: true })
    .eq('driver_id', (driver as any).driver_id).in('booking_id', bookingIds)
  return (count ?? 0) > 0
}

export async function findTargetUser(targetUserId: string): Promise<{ user_id: string; status: string; role: string } | null> {
  const { data, error } = await supabase.from('users').select('user_id, status, role').eq('user_id', targetUserId).maybeSingle()
  if (error) throw error
  return data as { user_id: string; status: string; role: string } | null
}