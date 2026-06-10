import { Router } from 'express'
import { authenticate } from '../middlewares/auth.middleware.js'
import * as push from '../controllers/messaging/push.controller.js'

const router = Router()

router.use(authenticate)

router.post('/push/subscribe',   push.subscribe)
router.post('/push/unsubscribe', push.unsubscribe)

export default router
