import { Request, Response, NextFunction } from 'express'
import * as messagingService from '../../services/messaging/messaging.service.js'
import {
  createConversationSchema,
  sendMessageSchema,
  getMessagesQuerySchema,
  reactSchema,
} from '../../schema/messaging/messaging.schema.js'

interface AuthUser { user_id: string; role: string }

function getAuthUser(req: Request): AuthUser {
  const user = (req as any).user as Record<string, unknown> | undefined
  if (!user) throw Object.assign(new Error('Unauthorized: no user on request'), { statusCode: 401 })
  const user_id = (user.user_id ?? user.id ?? user.sub) as string | undefined
  const role = user.role as string | undefined
  if (!user_id || user_id === 'undefined') throw Object.assign(new Error('Unauthorized: user_id missing'), { statusCode: 401 })
  if (!role) throw Object.assign(new Error('Unauthorized: role missing'), { statusCode: 401 })
  return { user_id, role }
}

export async function getConversations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const conversations = await messagingService.getConversations(user_id)
    res.json({ success: true, data: conversations })
  } catch (err) { next(err) }
}

export async function createOrGetConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuthUser(req)
    const parsed = createConversationSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors }); return }
    const conversation = await messagingService.getOrCreateConversation(user_id, role, parsed.data.target_user_id, parsed.data.booking_id)
    res.status(201).json({ success: true, data: conversation })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function getMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const conversationId = req.params.conversationId as string
    const parsed = getMessagesQuerySchema.safeParse(req.query)
    if (!parsed.success) { res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors }); return }
    const messages = await messagingService.getConversationMessages(conversationId, user_id, parsed.data.limit, parsed.data.before)
    res.json({ success: true, data: messages })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuthUser(req)
    const conversationId = req.params.conversationId as string
    const parsed = sendMessageSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors }); return }
    const message = await messagingService.sendMessage(conversationId, user_id, role, parsed.data.content, parsed.data.reply_to_message_id)
    res.status(201).json({ success: true, data: message })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const conversationId = req.params.conversationId as string
    await messagingService.markConversationAsRead(conversationId, user_id)
    res.json({ success: true })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function deleteMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    await messagingService.deleteMessage(req.params.messageId as string, user_id)
    res.json({ success: true })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function reactToMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const conversationId = req.params.conversationId as string
    const messageId = req.params.messageId as string
    const parsed = reactSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors }); return }
    const result = await messagingService.toggleReaction(conversationId, messageId, user_id, parsed.data.emoji)
    res.json({ success: true, data: result })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function getMessagableUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuthUser(req)
    const users = await messagingService.getMessagableUsers(user_id, role)
    res.json({ success: true, data: users })
  } catch (err) { next(err) }
}