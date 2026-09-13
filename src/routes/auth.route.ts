import { Router } from 'express'
import { validate }     from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import {
  authenticatedLimiter, authLimiter,
  passwordResetLimiter, resetRequestIpLimiter,
} from '../middlewares/rateLimit.middleware.js'
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
// Raising a request is throttled twice: per email by authLimiter, and per IP by
// resetRequestIpLimiter so one address cannot work through a list of accounts.
router.post('/forgot-password',       resetRequestIpLimiter, authLimiter, validate(requestPasswordResetSchema), PasswordResetController.requestReset)
// The link endpoints are throttled per TOKEN, not per IP — see passwordResetLimiter.
// authLimiter must not be used here: these bodies carry no email, so it would key
// them by IP and pool every reset behind a shared address into one small budget.
router.post('/reset-password/verify', passwordResetLimiter, validate(verifyResetTokenSchema),     PasswordResetController.verifyToken)
router.post('/reset-password',        passwordResetLimiter, validate(completeResetSchema),        PasswordResetController.completeReset)

// Protected
router.post('/logout',     authenticate, authenticatedLimiter, AuthController.logout)
router.post('/logout-all', authenticate, authenticatedLimiter, AuthController.logoutAll)
router.get('/me',          authenticate, authenticatedLimiter, AuthController.me)

export default router