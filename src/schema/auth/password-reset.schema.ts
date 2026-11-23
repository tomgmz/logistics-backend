import { z } from 'zod'
import { passwordField } from '../admin/shared.schema.js'

export const requestPasswordResetSchema = z.object({
  email: z.string().email('Invalid email address'),
})

// base64url of 32 random bytes is 43 chars; the bound is deliberately loose so a
// malformed token is rejected by the lookup (which leaks nothing) rather than by
// a validation message that describes the token format.
const tokenField = z.string().min(20).max(200)

export const verifyResetTokenSchema = z.object({
  token: tokenField,
})

export const completeResetSchema = z.object({
  token:    tokenField,
  // Same rule the rest of the system enforces, so a password accepted here is
  // one the login path will accept too.
  password: passwordField(),
})
