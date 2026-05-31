import { z } from 'zod'

export const createConversationSchema = z.object({
  target_user_id: z.string().uuid(),
  booking_id: z.string().uuid().optional(),
})

export const resolveConversationSchema = z.object({
  target_user_id: z.string().uuid(),
})

export const sendDirectMessageSchema = z.object({
  target_user_id: z.string().uuid(),
  content: z.string().min(1).max(5000).transform(v => v.trim()),
  reply_to_message_id: z.string().uuid().optional(),
  booking_id: z.string().uuid().optional(),
})

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(5000).transform(v => v.trim()),
  reply_to_message_id: z.string().uuid().optional(),
})

export const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
})

export const reactSchema = z.object({
  emoji: z.string().min(1).max(10),
})