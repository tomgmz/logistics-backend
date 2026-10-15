import { Router } from 'express'
import { authenticate } from '../middlewares/auth.middleware.js'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { clientIp } from '../lib/client-ip.js'
import { enforceClientMessagingPolicy } from '../middlewares/messaging.middleware.js'
import { uploadChatPhoto } from '../middlewares/upload.middleware.js'
import * as dm    from '../controllers/messaging/messaging.controller.js'
import * as group from '../controllers/messaging/group.controller.js'

const router = Router()

const readLimit = rateLimit({
  windowMs: 60_000, max: 60,
  keyGenerator: (req) => (req as any).user?.sub ?? ipKeyGenerator(clientIp(req)),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' },
})

const sendLimit = rateLimit({
  windowMs: 60_000, max: 30,
  keyGenerator: (req) => (req as any).user?.sub ?? ipKeyGenerator(clientIp(req)),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Message rate limit reached' },
})

router.use(authenticate)
router.use(readLimit)

// A photo for a chat message (multipart, field `image`, up to 10 MB). `stamp=1`
// plus taken_at / latitude / longitude / accuracy_m burns in the time-and-place
// stamp; without it the photo is stored plain. Returns the URL to send as the
// message's attachment_url.
router.post('/photos', sendLimit, (req, res, next) => {
  uploadChatPhoto(req, res, (err: unknown) => {
    if (!err) return next()
    const e = err as { code?: string; message?: string }
    const message = e.code === 'LIMIT_FILE_SIZE' ? 'Photos can be up to 10 MB' : e.message ?? 'Upload failed'
    res.status(400).json({ success: false, message })
  })
}, dm.uploadPhoto)

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
router.patch('/groups/:groupId',                                                group.renameGroup)
router.post('/groups/:groupId/members',                                         group.addMembers)
router.delete('/groups/:groupId/members/:userId',                               group.removeMember)
router.get('/groups/:groupId/requests',                                         group.listMemberRequests)
router.post('/groups/:groupId/requests/:requestId/decide',                      group.decideMemberRequest)
router.get('/groups/:groupId/messages',                                         group.getGroupMessages)
router.post('/groups/:groupId/messages',                    sendLimit,          group.sendGroupMessage)
router.patch('/groups/:groupId/read',                                           group.markGroupRead)
// Delete for me hides the message from the caller; ?scope=everyone unsends it (sender only).
router.delete('/groups/:groupId/messages/:messageId',                            group.hideGroupMessage)
router.post('/groups/:groupId/messages/:messageId/react',                       group.reactToGroupMessage)

export default router