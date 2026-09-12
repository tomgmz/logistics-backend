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
import {
  requestPasswordResetSchema,
  verifyResetTokenSchema,
  completeResetSchema,
} from '../schema/auth/password-reset.schema.js'
import * as AuthController from '../controllers/auth/auth.controller.js'
import * as PasswordResetController from '../controllers/auth/password-reset.controller.js'

const router = Router()

// Public
router.post('/request-otp', authLimiter, validate(requestOtpSchema), AuthController.requestOtp)
router.post('/verify-otp',  authLimiter, validate(verifyOtpSchema),  AuthController.verifyOtp)
router.post('/login',       authLimiter, validate(loginSchema),       AuthController.loginWithPassword)
router.post('/status',      validate(authStatusSchema),               AuthController.getAuthStatus)
router.post('/refresh',     AuthController.refreshToken)
router.get('/csrf',         AuthController.getCsrfToken)
router.post('/change-password', authenticate, authenticatedLimiter, validate(changePasswordSchema), AuthController.changePassword)

// Password reset — public by necessity: whoever needs these cannot sign in.
// `authLimiter` keys on the email in the body, which is what we want to throttle
// here. Completing a reset is keyed the same way because an attacker guessing
// tokens has no email to spend, so the limiter falls back to their IP.
router.post('/forgot-password',       authLimiter, validate(requestPasswordResetSchema), PasswordResetController.requestReset)
router.post('/reset-password/verify', authLimiter, validate(verifyResetTokenSchema),     PasswordResetController.verifyToken)
router.post('/reset-password',        authLimiter, validate(completeResetSchema),        PasswordResetController.completeReset)

// Protected
router.post('/logout',     authenticate, authenticatedLimiter, AuthController.logout)
router.post('/logout-all', authenticate, authenticatedLimiter, AuthController.logoutAll)
router.get('/me',          authenticate, authenticatedLimiter, AuthController.me)

export default router