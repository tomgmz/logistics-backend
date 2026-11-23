import { Router } from 'express'
import { validate }     from '../middlewares/validate.middleware.js'
import { authenticate } from '../middlewares/auth.middleware.js'
import {
  authenticatedLimiter, authLimiter, failedSignInIpLimiter, authStatusLimiter,
  passwordResetLimiter, resetRequestIpLimiter,
  passkeyEnrollLimiter, passkeyAuthLimiter, passkeyOptionsLimiter,
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
import {
  verifyInviteSchema,
  enrollOptionsSchema,
  enrollVerifySchema,
  authVerifySchema,
  registerVerifySchema,
} from '../schema/auth/webauthn.schema.js'
import * as AuthController from '../controllers/auth/auth.controller.js'
import * as PasswordResetController from '../controllers/auth/password-reset.controller.js'
import * as WebauthnController from '../controllers/auth/webauthn.controller.js'

const router = Router()

// Public. No captcha on sign-in or password reset (user 2026-11-16: the
// landing page's contact form only); the rate limiters guard these. An older
// web build's captcha_token is dropped by validate(). authLimiter counts per
// email; failedSignInIpLimiter counts wrong guesses per network address across
// all accounts (security review 2026-11-19).
router.post('/request-otp', authLimiter, validate(requestOtpSchema), AuthController.requestOtp)
router.post('/verify-otp',  failedSignInIpLimiter, authLimiter, validate(verifyOtpSchema),  AuthController.verifyOtp)
router.post('/login',       failedSignInIpLimiter, authLimiter, validate(loginSchema),       AuthController.loginWithPassword)
router.post('/status',      authStatusLimiter, validate(authStatusSchema),                    AuthController.getAuthStatus)
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
router.post('/reset-password',        passwordResetLimiter, validate(completeResetSchema), PasswordResetController.completeReset)

// The emailed-code reset (/it-admin/forgot-password, /it-admin/verify-otp) was
// retired on 2026-11-23: IT Administrator, Company Administrator and General
// Manager now get a reset link straight away from /forgot-password.

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
router.post('/passkey/authenticate/options', passkeyOptionsLimiter, WebauthnController.authOptions)
router.post('/passkey/authenticate/verify',  passkeyAuthLimiter, validate(authVerifySchema), WebauthnController.authVerify)

// Protected
// Signed-in enrolment, for 8338's own drivers: they already have a session, so
// the session authorises the ceremony instead of an emailed invite.
router.post('/passkey/register/options', authenticate, authenticatedLimiter, WebauthnController.registerOptions)
router.post('/passkey/register/verify',  authenticate, authenticatedLimiter, validate(registerVerifySchema), WebauthnController.registerVerify)
router.get('/passkey/credentials',                 authenticate, authenticatedLimiter, WebauthnController.listMine)
router.delete('/passkey/credentials/:credentialPk', authenticate, authenticatedLimiter, WebauthnController.removeMine)
router.post('/logout',     authenticate, authenticatedLimiter, AuthController.logout)
router.post('/logout-all', authenticate, authenticatedLimiter, AuthController.logoutAll)
router.get('/me',          authenticate, authenticatedLimiter, AuthController.me)
// Profile page (2026-11-07): the account's own details. No password change
// here: passwords are reset through the IT Administrator.
router.get('/profile',    authenticate, authenticatedLimiter, AuthController.profile)

export default router