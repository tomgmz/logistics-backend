import { Request, Response, NextFunction } from 'express'
import * as messagingModel from '../models/messaging/messaging.model.js'
import { assertCanSendInConversation } from '../services/messaging/messaging.service.js'

/**
 * Applies the client messaging rules (see messagingBlockReason) to a write into
 * an existing conversation, e.g. a reaction. Staff-to-staff conversations pass.
 */
export async function enforceClientMessagingPolicy(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = (req as any).user
  // authenticate puts the JWT payload here, so the id is `sub`; read it the
  // way the messaging controllers do.
  const userId = (user?.user_id ?? user?.id ?? user?.sub) as string | undefined

  if (!user || !user.role || !userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' })
    return
  }

  const conversationId = req.params.conversationId as string
  if (!conversationId) {
    next()
    return
  }

  try {
    const conversation = await messagingModel.findConversationById(conversationId)

    if (!conversation) {
      res.status(404).json({ success: false, message: 'Conversation not found' })
      return
    }

    if (conversation.participant_a_id !== userId && conversation.participant_b_id !== userId) {
      res.status(403).json({ success: false, message: 'Access denied' })
      return
    }

    await assertCanSendInConversation(conversation, userId, user.role)
    next()
  } catch (err) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) { res.status(e.statusCode).json({ success: false, message: e.message }); return }
    next(err)
  }
}
