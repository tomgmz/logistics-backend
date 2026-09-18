import { Router } from 'express'
import { validate }     from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import {
  authenticatedLimiter, authLimiter,
  passwordResetLimiter, resetRequestIpLimiter,
  passkeyEnrollLimiter, passkeyAuthLimiter,
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
  requestResetOtpSchema,
  verifyResetOtpSchema,
} from '../schema/auth/password-reset.schema.js'
import {
  verifyInviteSchema,
  enrollOptionsSchema,
  enrollVerifySchema,
  authVerifySchema,
} from '../schema/auth/webauthn.schema.js'
import * as AuthController from '../controllers/auth/auth.controller.js'
import * as PasswordResetController from '../controllers/auth/password-reset.controller.js'
import * as WebauthnController from '../controllers/auth/webauthn.controller.js'

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

// The IT Admin's self-service reset, by emailed code.
//
// Throttled exactly like the mediated request - per email and per IP - so the
// pair cannot be used against each other: hitting the ceiling on one does not
// hand anyone a fresh budget on the other for the same address. The service
// enforces its own one-code-per-minute cooldown on top, because a limiter that
// counts requests cannot tell a resend from a first ask.
router.post('/it-admin/forgot-password', resetRequestIpLimiter, authLimiter, validate(requestResetOtpSchema), PasswordResetController.requestOtp)
// Guessing IS the threat here - a six-digit code is small enough to brute-force
// at any useful request rate - so this is keyed per email and backed by the
// five-attempt budget on the request row itself, which is what actually stops it.
router.post('/it-admin/verify-otp',      authLimiter,                          validate(verifyResetOtpSchema),  PasswordResetController.verifyOtp)

// Passkeys, for outside-vendor drivers.
//
// Enrolment is authorised by the emailed invite token, so these are public in
// the same sense the reset link endpoints are: whoever needs them has no session
// yet. They are throttled per token rather than per IP so a vendor yard's shared
// connection does not pool every driver into one budget.
router.post('/passkey/enroll/verify-invite', passkeyEnrollLimiter, validate(verifyInviteSchema), WebauthnController.verifyInvite)
router.post('/passkey/enroll/options',       passkeyEnrollLimiter, validate(enrollOptionsSchema), WebauthnController.enrollOptions)
router.post('/passkey/enroll/verify',        passkeyEnrollLimiter, validate(enrollVerifySchema),  WebauthnController.enrollVerify)

// Sign-in. The options request carries NO body at all — discoverable credentials
// mean the device offers what it holds and the server learns who is signing in
// only from the assertion, which is what leaves nothing here to enumerate.
router.post('/passkey/authenticate/options', passkeyAuthLimiter, WebauthnController.authOptions)
router.post('/passkey/authenticate/verify',  passkeyAuthLimiter, validate(authVerifySchema), WebauthnController.authVerify)

// Protected
router.get('/passkey/credentials',                 authenticate, authenticatedLimiter, WebauthnController.listMine)
router.delete('/passkey/credentials/:credentialPk', authenticate, authenticatedLimiter, WebauthnController.removeMine)
router.post('/logout',     authenticate, authenticatedLimiter, AuthController.logout)
router.post('/logout-all', authenticate, authenticatedLimiter, AuthController.logoutAll)
router.get('/me',          authenticate, authenticatedLimiter, AuthController.me)

export default router