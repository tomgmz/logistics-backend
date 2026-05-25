import { z } from 'zod'

export const createConversationSchema = z.object({
  target_user_id: z.string().uuid('Invalid user ID'),
  booking_id: z.string().uuid('Invalid booking ID').optional(),
})

export const sendMessageSchema = z.object({
  content: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(5000, 'Message cannot exceed 5000 characters')
    .transform(v => v.trim()),
})

export const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
})

export type CreateConversationInput = z.infer<typeof createConversationSchema>
export type SendMessageInput = z.infer<typeof sendMessageSchema>
export type GetMessagesQuery = z.infer<typeof getMessagesQuerySchema>