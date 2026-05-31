import { Request, Response, NextFunction } from 'express'
import * as service from '../../services/messaging/messaging.service.js'
import {
  createConversationSchema,
  resolveConversationSchema,
  sendDirectMessageSchema,
  sendMessageSchema,
  getMessagesQuerySchema,
  reactSchema,
} from '../../schema/messaging/messaging.schema.js'

function getAuth(req: Request): { user_id: string; role: string } {
  const u = (req as Request & { user?: Record<string, unknown> }).user
  if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  const user_id = (u.user_id ?? u.id ?? u.sub) as string | undefined
  const role    = u.role as string | undefined
  if (!user_id || user_id === 'undefined') throw Object.assign(new Error('user_id missing'), { statusCode: 401 })
  if (!role) throw Object.assign(new Error('role missing'), { statusCode: 401 })
  return { user_id, role }
}

function fail(res: Response, err: unknown): void {
  const e = err as { statusCode?: number; message?: string }
  if (e.statusCode) { res.status(e.statusCode).json({ success: false, message: e.message }); return }
  throw err
}

export async function getConversations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    res.json({ success: true, data: await service.getConversations(user_id) })
  } catch (err) { next(err) }
}

export async function createOrGetConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuth(req)
    const p = createConversationSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.status(201).json({ success: true, data: await service.getOrCreateConversation(user_id, role, p.data.target_user_id, p.data.booking_id) })
  } catch (err) { fail(res, err) }
}

export async function resolveConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuth(req)
    const p = resolveConversationSchema.safeParse(req.query)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.json({ success: true, data: await service.resolveConversation(user_id, role, p.data.target_user_id) })
  } catch (err) { fail(res, err) }
}

export async function sendDirectMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuth(req)
    const p = sendDirectMessageSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.status(201).json({ success: true, data: await service.sendDirectMessage(user_id, role, p.data.target_user_id, p.data.content, p.data.reply_to_message_id, p.data.booking_id) })
  } catch (err) { fail(res, err) }
}

export async function getMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = getMessagesQuerySchema.safeParse(req.query)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.json({ success: true, data: await service.getConversationMessages(req.params.conversationId as string, user_id, p.data.limit, p.data.before) })
  } catch (err) { fail(res, err) }
}

export async function sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuth(req)
    const p = sendMessageSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.status(201).json({ success: true, data: await service.sendMessage(req.params.conversationId as string, user_id, role, p.data.content, p.data.reply_to_message_id) })
  } catch (err) { fail(res, err) }
}

export async function markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    await service.markConversationAsRead(req.params.conversationId as string, user_id)
    res.json({ success: true })
  } catch (err) { fail(res, err) }
}

export async function deleteMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    await service.deleteMessage(req.params.messageId as string, user_id)
    res.json({ success: true })
  } catch (err) { fail(res, err) }
}

export async function reactToMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = reactSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.json({ success: true, data: await service.toggleReaction(req.params.conversationId as string, req.params.messageId as string, user_id, p.data.emoji) })
  } catch (err) { fail(res, err) }
}

export async function getMessagableUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuth(req)
    res.json({ success: true, data: await service.getMessagableUsers(user_id, role) })
  } catch (err) { next(err) }
}