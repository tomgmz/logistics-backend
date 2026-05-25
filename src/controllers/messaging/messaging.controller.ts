import { Request, Response, NextFunction } from 'express'
import * as messagingService from '../../services/messaging/messaging.service.js'
import {
  createConversationSchema,
  sendMessageSchema,
  getMessagesQuerySchema,
} from '../../schema/messaging/messaging.schema.js'

// ── Helper: extract and validate the authenticated user from req ─────────────
// Adjust the field names here if your JWT middleware uses different keys
// (e.g. 'id' instead of 'user_id', or 'sub' instead of 'user_id').
interface AuthUser {
  user_id: string
  role: string
}

function getAuthUser(req: Request): AuthUser {
  const user = (req as any).user as Record<string, unknown> | undefined

  if (!user) {
    throw Object.assign(new Error('Unauthorized: no user on request'), { statusCode: 401 })
  }

  // Support both 'user_id' and 'id' field names so a JWT mismatch surfaces a clear error
  const user_id = (user.user_id ?? user.id ?? user.sub) as string | undefined
  const role = user.role as string | undefined

  if (!user_id || user_id === 'undefined') {
    throw Object.assign(
      new Error(`Unauthorized: user_id missing from token. Available keys: ${Object.keys(user).join(', ')}`),
      { statusCode: 401 }
    )
  }

  if (!role) {
    throw Object.assign(new Error('Unauthorized: role missing from token'), { statusCode: 401 })
  }

  return { user_id, role }
}

// ── Controllers ───────────────────────────────────────────────────────────────

export async function getConversations(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const conversations = await messagingService.getConversations(user_id)
    res.json({ success: true, data: conversations })
  } catch (err) {
    next(err)
  }
}

export async function createOrGetConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user_id, role } = getAuthUser(req)
    const parsed = createConversationSchema.safeParse(req.body)

    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }

    const conversation = await messagingService.getOrCreateConversation(
      user_id,
      role,
      parsed.data.target_user_id,
      parsed.data.booking_id
    )

    res.status(201).json({ success: true, data: conversation })
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) {
      res.status(e.statusCode).json({ success: false, message: e.message })
      return
    }
    next(err)
  }
}

export async function getMessages(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const conversationId = req.params.conversationId as string
    const parsed = getMessagesQuerySchema.safeParse(req.query)

    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }

    const messages = await messagingService.getConversationMessages(
      conversationId,
      user_id,
      parsed.data.limit,
      parsed.data.before
    )

    res.json({ success: true, data: messages })
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) {
      res.status(e.statusCode).json({ success: false, message: e.message })
      return
    }
    next(err)
  }
}

export async function sendMessage(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user_id, role } = getAuthUser(req)
    const conversationId = req.params.conversationId as string
    const parsed = sendMessageSchema.safeParse(req.body)

    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }

    const message = await messagingService.sendMessage(
      conversationId,
      user_id,
      role,
      parsed.data.content
    )

    res.status(201).json({ success: true, data: message })
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) {
      res.status(e.statusCode).json({ success: false, message: e.message })
      return
    }
    next(err)
  }
}

export async function markAsRead(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const conversationId = req.params.conversationId as string

    await messagingService.markConversationAsRead(conversationId, user_id)
    res.json({ success: true })
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) {
      res.status(e.statusCode).json({ success: false, message: e.message })
      return
    }
    next(err)
  }
}

export async function deleteMessage(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const messageId = req.params.messageId as string

    await messagingService.deleteMessage(messageId, user_id)
    res.json({ success: true })
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) {
      res.status(e.statusCode).json({ success: false, message: e.message })
      return
    }
    next(err)
  }
}

export async function getMessagableUsers(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user_id, role } = getAuthUser(req)
    const users = await messagingService.getMessagableUsers(user_id, role)
    res.json({ success: true, data: users })
  } catch (err) {
    next(err)
  }
}