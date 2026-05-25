import * as messagingModel from '../../models/messaging/messaging.model.js'
import { createClient } from '@supabase/supabase-js'
import type { ConversationWithDetails, MessageRow, MessagableUser } from '../../types/messaging.types.js'

// ── Supabase admin client for Realtime broadcast ──────────────────────────────
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function broadcastNewMessage(message: MessageRow): Promise<void> {
  await Promise.allSettled([
    // Per-user channels (for MessagingShell + MessengerFloatingPanel)
    supabaseAdmin.channel(`messaging:user:${message.sender_id}`).send({
      type: 'broadcast',
      event: 'new_message',
      payload: message,
    }),
    supabaseAdmin.channel(`messaging:user:${message.receiver_id}`).send({
      type: 'broadcast',
      event: 'new_message',
      payload: message,
    }),
    // Per-conversation channel (for ChatWindow + MessengerChatBubble)
    supabaseAdmin.channel(`messaging:conv:${message.conversation_id}`).send({
      type: 'broadcast',
      event: 'new_message',
      payload: message,
    }),
  ])
}

// ─────────────────────────────────────────────────────────────────────────────

export async function getConversations(userId: string): Promise<ConversationWithDetails[]> {
  return messagingModel.getConversationsByUserId(userId)
}

export async function getOrCreateConversation(
  currentUserId: string,
  currentUserRole: string,
  targetUserId: string,
  bookingId?: string
) {
  if (currentUserId === targetUserId) {
    throw Object.assign(new Error('Cannot create a conversation with yourself'), { statusCode: 400 })
  }

  const targetUser = await messagingModel.findTargetUser(targetUserId)
  if (!targetUser || targetUser.status !== 'active') {
    throw Object.assign(new Error('User not found or inactive'), { statusCode: 404 })
  }

  if (currentUserRole === 'client') {
    const isDriverRole = targetUser.role === 'driver'
    if (!isDriverRole) {
      throw Object.assign(
        new Error('Clients can only message drivers assigned to their bookings'),
        { statusCode: 403 }
      )
    }
    const canMessage = await messagingModel.validateClientDriverAccess(currentUserId, targetUserId)
    if (!canMessage) {
      throw Object.assign(
        new Error('No active in-transit booking found with this driver'),
        { statusCode: 403 }
      )
    }
  }

  const existing = await messagingModel.findConversationByParticipants(currentUserId, targetUserId)
  if (existing) return existing

  const contextType = currentUserRole === 'client' ? 'booking_transit' : 'direct'
  return messagingModel.createConversation(currentUserId, targetUserId, contextType, bookingId)
}

export async function getConversationMessages(
  conversationId: string,
  userId: string,
  limit: number,
  before?: string
): Promise<MessageRow[]> {
  const conversation = await messagingModel.findConversationById(conversationId)
  if (!conversation) {
    throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  }

  const isParticipant =
    conversation.participant_a_id === userId || conversation.participant_b_id === userId
  if (!isParticipant) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  }

  return messagingModel.getMessagesByConversationId(conversationId, userId, limit, before)
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  senderRole: string,
  content: string
): Promise<MessageRow> {
  const conversation = await messagingModel.findConversationById(conversationId)
  if (!conversation) {
    throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  }

  const isParticipant =
    conversation.participant_a_id === senderId || conversation.participant_b_id === senderId
  if (!isParticipant) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  }

  const receiverId =
    conversation.participant_a_id === senderId
      ? conversation.participant_b_id
      : conversation.participant_a_id

  if (senderRole === 'client') {
    const canMessage = await messagingModel.validateClientDriverAccess(senderId, receiverId)
    if (!canMessage) {
      throw Object.assign(
        new Error('Messaging is only allowed while a booking with this driver is in transit'),
        { statusCode: 403 }
      )
    }
  }

  const message = await messagingModel.insertMessage(conversationId, senderId, receiverId, content)
  await messagingModel.touchConversation(conversationId)

  // Fire-and-forget broadcast — never blocks the HTTP response
  broadcastNewMessage(message).catch(err =>
    console.error('[Realtime] broadcast failed:', err)
  )

  return message
}

export async function markConversationAsRead(conversationId: string, userId: string): Promise<void> {
  const conversation = await messagingModel.findConversationById(conversationId)
  if (!conversation) {
    throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  }

  const isParticipant =
    conversation.participant_a_id === userId || conversation.participant_b_id === userId
  if (!isParticipant) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  }

  await messagingModel.markMessagesRead(conversationId, userId)
}

export async function deleteMessage(messageId: string, userId: string): Promise<void> {
  const message = await messagingModel.findMessageById(messageId)
  if (!message) {
    throw Object.assign(new Error('Message not found'), { statusCode: 404 })
  }

  const isSender = message.sender_id === userId
  const isReceiver = message.receiver_id === userId

  if (!isSender && !isReceiver) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  }

  await messagingModel.softDeleteMessage(messageId, userId, isSender)
}

export async function getMessagableUsers(
  userId: string,
  role: string
): Promise<MessagableUser[]> {
  if (role === 'client') {
    return messagingModel.getMessagableDriversForClient(userId)
  }
  return messagingModel.getMessagableUsersForStaff(userId)
}