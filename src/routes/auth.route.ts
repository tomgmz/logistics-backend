import { Router } from 'express'
import { validate }     from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import { requestOtpSchema, verifyOtpSchema } from '../schema/auth/auth.schema.js'
import * as AuthController from '../controllers/auth/auth.controller.js'

const router = Router()

// Public
router.post('/request-otp', validate(requestOtpSchema), AuthController.requestOtp)
router.post('/verify-otp',  validate(verifyOtpSchema),  AuthController.verifyOtp)

// Protected
router.post('/logout', authenticate, AuthController.logout)
router.get('/me',      authenticate, AuthController.me)

export default router

