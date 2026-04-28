import { z } from 'zod'

export const requestOtpSchema = z.object({
  email: z.string().email('Invalid email address'),
})

export const verifyOtpSchema = z.object({
  email:       z.string().email('Invalid email address'),
  code:        z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
  device_info: z.string().optional(),
  platform:    z.enum(['web', 'mobile']).default('web'),
})

export const authStatusSchema = z.object({
  email: z.string().email('Invalid email address'),
})

export const loginSchema = z.object({
  email:       z.string().email('Invalid email address'),
  password:    z.string().min(1, 'Password is required'),
  device_info: z.string().optional(),
  platform:    z.enum(['web', 'mobile']).default('web'),
})