import { z } from 'zod'

export const createConversationSchema = z.object({
  target_user_id: z.string().uuid(),
  booking_id: z.string().uuid().optional(),
})

export const resolveConversationSchema = z.object({
  target_user_id: z.string().uuid(),
})

/** Stands in for the caption of a photo sent without one, so previews read "📷 Photo". */
export const PHOTO_PLACEHOLDER = '📷 Photo'

/**
 * Text, a photo (attachment_url from POST /messaging/photos) with an optional
 * caption, or both. The URL itself is checked by the service.
 */
export const messageBody = {
  content: z.string().max(5000).optional().default('').transform(v => v.trim()),
  attachment_url: z.string().url().max(1000).optional(),
  reply_to_message_id: z.string().uuid().optional(),
}

const needsContent = (v: { content: string; attachment_url?: string }) => v.content.length > 0 || !!v.attachment_url

export const sendDirectMessageSchema = z.object({
  target_user_id: z.string().uuid(),
  ...messageBody,
  booking_id: z.string().uuid().optional(),
}).refine(needsContent, { message: 'Type a message or add a photo', path: ['content'] })

export const sendMessageSchema = z.object(messageBody)
  .refine(needsContent, { message: 'Type a message or add a photo', path: ['content'] })

export const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
})

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'] as const

export const reactSchema = z.object({
  emoji: z.enum(REACTION_EMOJIS),
})
export const startChatCallSchema = z.object({
  conversation_id: z.string().uuid(),
})

export const endChatCallSchema = z.object({
  reason: z.enum(['hangup', 'no_answer', 'failed']).optional().default('hangup'),
  detail: z.string().max(500).optional(),
})
