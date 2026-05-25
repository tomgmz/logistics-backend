import { Request, Response, NextFunction } from 'express'
import * as messagingModel from '../models/messaging/messaging.model.js'

export async function enforceClientMessagingPolicy(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = (req as any).user

  if (!user || !user.role) {
    res.status(401).json({ success: false, message: 'Unauthorized' })
    return
  }

  if (user.role !== 'client') {
    next()
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

    const isParticipant =
      conversation.participant_a_id === user.user_id ||
      conversation.participant_b_id === user.user_id

    if (!isParticipant) {
      res.status(403).json({ success: false, message: 'Access denied' })
      return
    }

    const receiverId =
      conversation.participant_a_id === user.user_id
        ? conversation.participant_b_id
        : conversation.participant_a_id

    const canMessage = await messagingModel.validateClientDriverAccess(user.user_id, receiverId)

    if (!canMessage) {
      res.status(403).json({
        success: false,
        message: 'Messaging is only allowed while a booking with this driver is in transit',
      })
      return
    }

    next()
  } catch (err) {
    next(err)
  }
}