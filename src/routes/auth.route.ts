import { Router } from 'express'
import { validate }     from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter, authLimiter } from '../middlewares/rateLimit.middleware.js'
import {
  requestOtpSchema,
  verifyOtpSchema,
  authStatusSchema,
  loginSchema,
  changePasswordSchema,
} from '../schema/auth/auth.schema.js'
import * as AuthController from '../controllers/auth/auth.controller.js'

const router = Router()

// Public
router.post('/request-otp', authLimiter, validate(requestOtpSchema), AuthController.requestOtp)
router.post('/verify-otp',  authLimiter, validate(verifyOtpSchema),  AuthController.verifyOtp)
router.post('/login',       authLimiter, validate(loginSchema),       AuthController.loginWithPassword)
router.post('/status',      validate(authStatusSchema),               AuthController.getAuthStatus)
router.post('/refresh',     AuthController.refreshToken)
router.get('/csrf',         AuthController.getCsrfToken)
router.post('/change-password', authenticate, authenticatedLimiter, validate(changePasswordSchema), AuthController.changePassword)

// Protected
router.post('/logout',     authenticate, authenticatedLimiter, AuthController.logout)
router.post('/logout-all', authenticate, authenticatedLimiter, AuthController.logoutAll)
router.get('/me',          authenticate, authenticatedLimiter, AuthController.me)

export default router