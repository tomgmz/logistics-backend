import { Router } from 'express'
import { authenticate } from '../middlewares/auth.middleware.js'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { enforceClientMessagingPolicy } from '../middlewares/messaging.middleware.js'
import * as messagingController from '../controllers/messaging/messaging.controller.js'

const router = Router()

const messagingRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  // Use user_id when authenticated; fall back to ipKeyGenerator for unauthenticated requests.
  // ipKeyGenerator normalises IPv4-mapped IPv6 addresses so users can't bypass limits.
  keyGenerator: (req) => (req as any).user?.user_id ?? ipKeyGenerator(req.ip ?? ''),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' },
})

const sendRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req as any).user?.user_id ?? ipKeyGenerator(req.ip ?? ''),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Message rate limit reached' },
})

router.use(authenticate)
router.use(messagingRateLimit)

router.get('/users', messagingController.getMessagableUsers)

router.get('/conversations', messagingController.getConversations)
router.post('/conversations', messagingController.createOrGetConversation)

router.get(
  '/conversations/:conversationId/messages',
  messagingController.getMessages
)

router.post(
  '/conversations/:conversationId/messages',
  sendRateLimit,
  enforceClientMessagingPolicy,
  messagingController.sendMessage
)

router.patch(
  '/conversations/:conversationId/read',
  messagingController.markAsRead
)

router.delete('/messages/:messageId', messagingController.deleteMessage)

export default router