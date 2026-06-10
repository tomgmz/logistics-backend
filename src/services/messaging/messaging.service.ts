import * as model from '../../models/messaging/messaging.model.js'
import * as push from './push.service.js'
import { createClient } from '@supabase/supabase-js'
import type { ConversationWithDetails, MessageRow, MessagableUser } from '../../types/messaging.types.js'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)


async function broadcast(channel: string, event: string, payload: unknown): Promise<void> {
  await admin.channel(channel).send({ type: 'broadcast', event, payload })
}

async function assertCanMessage(currentUserId: string, currentUserRole: string, targetUserId: string) {
  if (currentUserId === targetUserId) throw Object.assign(new Error('Cannot message yourself'), { statusCode: 400 })

  const target = await model.findTargetUser(targetUserId)
  if (!target || target.status !== 'active') throw Object.assign(new Error('User not found or inactive'), { statusCode: 404 })

  if (currentUserRole === 'client') {
    if (target.role !== 'driver') throw Object.assign(new Error('Clients can only message drivers assigned to their bookings'), { statusCode: 403 })
    const ok = await model.validateClientDriverAccess(currentUserId, targetUserId)
    if (!ok) throw Object.assign(new Error('No active in-transit booking found with this driver'), { statusCode: 403 })
  }
  return target
}

async function deliverMessage(
  conv: { conversation_id: string; participant_a_id: string; participant_b_id: string },
  senderId: string,
  content: string,
  replyToMessageId?: string
): Promise<MessageRow> {
  const receiverId = conv.participant_a_id === senderId ? conv.participant_b_id : conv.participant_a_id

  let reply_to: { message_id: string; content: string; sender_id: string } | null = null
  if (replyToMessageId) {
    const ref = await model.findMessageById(replyToMessageId)
    if (!ref || ref.conversation_id !== conv.conversation_id)
      throw Object.assign(new Error('Reply target not found in this conversation'), { statusCode: 400 })
    reply_to = { message_id: ref.message_id, content: ref.content, sender_id: ref.sender_id }
  }

  const message = await model.insertMessage(conv.conversation_id, senderId, receiverId, content, replyToMessageId)
  await model.touchConversation(conv.conversation_id)

  const payload = { ...message, reply_to }

  void Promise.allSettled([
    broadcast(`messaging:user:${senderId}`, 'new_message', payload),
    broadcast(`messaging:user:${receiverId}`, 'new_message', payload),
    broadcast(`messaging:conv:${conv.conversation_id}`, 'new_message', payload),
  ])

  void push.getDisplayName(senderId).then((title) =>
    push.sendToUsers([receiverId], {
      title,
      body: push.preview(content),
      data: { type: 'direct', conversation_id: conv.conversation_id, message_id: message.message_id, sender_id: senderId },
    })
  )

  return payload
}


export async function getConversations(userId: string): Promise<ConversationWithDetails[]> {
  return model.getConversationsByUserId(userId)
}

export async function getOrCreateConversation(
  currentUserId: string,
  currentUserRole: string,
  targetUserId: string,
  bookingId?: string
) {
  if (currentUserId === targetUserId) throw Object.assign(new Error('Cannot create a conversation with yourself'), { statusCode: 400 })

  const target = await model.findTargetUser(targetUserId)
  if (!target || target.status !== 'active') throw Object.assign(new Error('User not found or inactive'), { statusCode: 404 })

  if (currentUserRole === 'client') {
    if (target.role !== 'driver') throw Object.assign(new Error('Clients can only message drivers assigned to their bookings'), { statusCode: 403 })
    const ok = await model.validateClientDriverAccess(currentUserId, targetUserId)
    if (!ok) throw Object.assign(new Error('No active in-transit booking found with this driver'), { statusCode: 403 })
  }

  const existing = await model.findConversationByParticipants(currentUserId, targetUserId)
  if (existing) return existing
  return model.createConversation(currentUserId, targetUserId, currentUserRole === 'client' ? 'booking_transit' : 'direct', bookingId)
}

export async function getConversationMessages(conversationId: string, userId: string, limit: number, before?: string): Promise<MessageRow[]> {
  const conv = await model.findConversationById(conversationId)
  if (!conv) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  if (conv.participant_a_id !== userId && conv.participant_b_id !== userId) throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  return model.getMessagesByConversationId(conversationId, userId, limit, before)
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  senderRole: string,
  content: string,
  replyToMessageId?: string
): Promise<MessageRow> {
  const conv = await model.findConversationById(conversationId)
  if (!conv) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  if (conv.participant_a_id !== senderId && conv.participant_b_id !== senderId) throw Object.assign(new Error('Access denied'), { statusCode: 403 })

  const receiverId = conv.participant_a_id === senderId ? conv.participant_b_id : conv.participant_a_id
  if (senderRole === 'client') {
    const ok = await model.validateClientDriverAccess(senderId, receiverId)
    if (!ok) throw Object.assign(new Error('Messaging only allowed while booking is in transit'), { statusCode: 403 })
  }

  return deliverMessage(conv, senderId, content, replyToMessageId)
}

export async function resolveConversation(
  currentUserId: string,
  currentUserRole: string,
  targetUserId: string
): Promise<{ conversation_id: string | null }> {
  await assertCanMessage(currentUserId, currentUserRole, targetUserId)
  const existing = await model.findConversationByParticipants(currentUserId, targetUserId)
  return { conversation_id: existing?.conversation_id ?? null }
}

export async function sendDirectMessage(
  currentUserId: string,
  currentUserRole: string,
  targetUserId: string,
  content: string,
  replyToMessageId?: string,
  bookingId?: string
): Promise<MessageRow> {
  await assertCanMessage(currentUserId, currentUserRole, targetUserId)

  const conv = await model.findConversationByParticipants(currentUserId, targetUserId)
    ?? await model.createConversation(
      currentUserId,
      targetUserId,
      currentUserRole === 'client' ? 'booking_transit' : 'direct',
      bookingId
    )

  return deliverMessage(conv, currentUserId, content, replyToMessageId)
}

export async function markConversationAsRead(conversationId: string, userId: string): Promise<void> {
  const conv = await model.findConversationById(conversationId)
  if (!conv) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  if (conv.participant_a_id !== userId && conv.participant_b_id !== userId) throw Object.assign(new Error('Access denied'), { statusCode: 403 })

  const last_read_at = await model.markMessagesRead(conversationId, userId)
  const senderId     = conv.participant_a_id === userId ? conv.participant_b_id : conv.participant_a_id
  const payload      = { conversation_id: conversationId, reader_id: userId, last_read_at }
  void Promise.allSettled([
    broadcast(`messaging:user:${senderId}`, 'read_receipt', payload),
    broadcast(`messaging:conv:${conversationId}`, 'read_receipt', payload),
  ])
}

export async function deleteMessage(messageId: string, userId: string): Promise<void> {
  const msg = await model.findMessageById(messageId)
  if (!msg) throw Object.assign(new Error('Message not found'), { statusCode: 404 })
  const isSender   = msg.sender_id === userId
  const isReceiver = msg.receiver_id === userId
  if (!isSender && !isReceiver) throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  await model.softDeleteMessage(messageId, userId, isSender)
}

export async function toggleReaction(
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string
): Promise<{ action: 'added' | 'removed' }> {
  const conv = await model.findConversationById(conversationId)
  if (!conv) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  if (conv.participant_a_id !== userId && conv.participant_b_id !== userId) throw Object.assign(new Error('Access denied'), { statusCode: 403 })

  const result  = await model.toggleMessageReaction(messageId, userId, emoji)
  const otherId = conv.participant_a_id === userId ? conv.participant_b_id : conv.participant_a_id
  const payload = { message_id: messageId, user_id: userId, emoji, action: result.action }

  void Promise.allSettled([
    broadcast(`messaging:conv:${conversationId}`, 'reaction_toggle', payload),
    broadcast(`messaging:user:${userId}`, 'reaction_toggle', payload),
    broadcast(`messaging:user:${otherId}`, 'reaction_toggle', payload),
  ])
  return result
}

export async function getMessagableUsers(userId: string, role: string): Promise<MessagableUser[]> {
  return role === 'client' ? model.getMessagableDriversForClient(userId) : model.getMessagableUsersForStaff(userId)
}