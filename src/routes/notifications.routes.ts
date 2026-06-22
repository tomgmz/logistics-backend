import { Router } from 'express'
import { authenticate } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import * as push from '../controllers/messaging/push.controller.js'
import * as notifications from '../controllers/notification/notification.controller.js'

const router = Router()

router.use(authenticate)

router.post('/push/subscribe',   push.subscribe)
router.post('/push/unsubscribe', push.unsubscribe)

// In-app notification center (each user only ever sees their own rows).
router.get('/',              authenticatedLimiter, notifications.list)
router.get('/unread-count',  authenticatedLimiter, notifications.unreadCount)
router.patch('/read-all',    authenticatedLimiter, notifications.markAllRead)
router.patch('/:id/read',    authenticatedLimiter, notifications.markRead)

export default router
