import { Router } from 'express'
import { authenticate } from '../middlewares/auth.middleware.js'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { enforceClientMessagingPolicy } from '../middlewares/messaging.middleware.js'
import * as dm    from '../controllers/messaging/messaging.controller.js'
import * as group from '../controllers/messaging/group.controller.js'

const router = Router()

const readLimit = rateLimit({
  windowMs: 60_000, max: 60,
  keyGenerator: (req) => (req as any).user?.user_id ?? ipKeyGenerator(req.ip ?? ''),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' },
})

const sendLimit = rateLimit({
  windowMs: 60_000, max: 30,
  keyGenerator: (req) => (req as any).user?.user_id ?? ipKeyGenerator(req.ip ?? ''),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Message rate limit reached' },
})

router.use(authenticate)
router.use(readLimit)

router.get('/users',                                                            dm.getMessagableUsers)
router.get('/conversations',                                                    dm.getConversations)
router.post('/conversations',                                                   dm.createOrGetConversation)
router.get('/conversations/resolve',                                            dm.resolveConversation)
router.post('/conversations/direct',                       sendLimit,           dm.sendDirectMessage)
router.get('/conversations/:conversationId/messages',                           dm.getMessages)
router.post('/conversations/:conversationId/messages', sendLimit, enforceClientMessagingPolicy, dm.sendMessage)
router.patch('/conversations/:conversationId/read',                             dm.markAsRead)
router.delete('/messages/:messageId',                                           dm.deleteMessage)
router.post('/conversations/:conversationId/messages/:messageId/react', enforceClientMessagingPolicy, dm.reactToMessage)

router.post('/groups',                                                          group.createGroup)
router.get('/groups',                                                           group.getGroups)
router.patch('/groups/:groupId/invite/respond',                                 group.respondToInvite)
router.get('/groups/:groupId/messages',                                         group.getGroupMessages)
router.post('/groups/:groupId/messages',                    sendLimit,          group.sendGroupMessage)
router.patch('/groups/:groupId/read',                                           group.markGroupRead)
router.post('/groups/:groupId/messages/:messageId/react',                       group.reactToGroupMessage)

export default router