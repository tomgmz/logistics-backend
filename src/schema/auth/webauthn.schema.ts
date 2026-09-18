import { z } from 'zod'

// The enrolment token as it arrives from the emailed link: 32 random bytes,
// base64url. Bounded so an oversized body is rejected before it reaches a hash.
const enrollmentToken = z.string().trim().min(20).max(200)

export const verifyInviteSchema = z.object({
  token: enrollmentToken,
})

export const enrollOptionsSchema = z.object({
  token: enrollmentToken,
})

export const enrollVerifySchema = z.object({
  token: enrollmentToken,
  // The credential is passed straight to @simplewebauthn, which does the real
  // structural validation. Re-describing its shape here would mean maintaining a
  // second copy of the WebAuthn spec that could only ever drift from the first.
  credential: z.object({}).passthrough(),
  // Free text from the device, shown to admins in the passkey list. Never used
  // for any decision, so it only needs a length bound.
  device_label: z.string().trim().max(80).optional(),
})

export const authVerifySchema = z.object({
  credential: z.object({}).passthrough(),
})

export type VerifyInviteInput  = z.infer<typeof verifyInviteSchema>
export type EnrollOptionsInput = z.infer<typeof enrollOptionsSchema>
export type EnrollVerifyInput  = z.infer<typeof enrollVerifySchema>
export type AuthVerifyInput    = z.infer<typeof authVerifySchema>
