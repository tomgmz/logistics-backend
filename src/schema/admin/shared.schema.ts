import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

export const emailField = () =>
  z
    .string()
    .email('Invalid email address')
    .min(5, 'Email is too short')
    .max(254, 'Email is too long')
    .regex(
      /^[a-zA-Z0-9](?:[a-zA-Z0-9]|[._%+-](?=[a-zA-Z0-9]))*@(?:[a-zA-Z0-9-]+\.){1,3}[a-zA-Z]{2,}$/,
      'Invalid email address'
    )
    .transform(v => v.toLowerCase())

export const mobileField = () =>
  z
    .string()
    .regex(
      /^\+639[0-9]{9}$/,
      'Phone must be a valid PH mobile number (+639XXXXXXXXX)'
    )

export const landlineField = () =>
  z
    .string()
    .regex(/^\+63[0-9]{9}$/, 'Landline must be a valid PH landline')
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v)

export const passwordField = () =>
  z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must include at least one uppercase letter')
    .regex(/[a-z]/, 'Password must include at least one lowercase letter')
    .regex(/[0-9]/, 'Password must include at least one number')

const licenseRegex   = /^[A-Z]\d{2}-\d{2}-\d{6}$/
const licenseMessage = 'Invalid LTO license number format (e.g. A01-23-456789)'

export const licenseNumberField = () =>
  z.string().regex(licenseRegex, licenseMessage)

export const licenseExpiryField = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)')
    .refine(val => !isNaN(new Date(val).getTime()), 'Invalid date')
    .refine(val => new Date(val) > new Date(), 'License is already expired')

export const coreCreateFields = () => ({
  first_name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u,
      'First name must contain only letters, spaces, hyphens, or apostrophes'
    ),
  last_name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u,
      'Last name must contain only letters, spaces, hyphens, or apostrophes'
    ),
  middle_initial: z
    .string()
    .max(1)
    .regex(/^[\p{L}]$/u, 'Middle initial must be a letter')
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),
  suffix: z.preprocess(
    v => v === '' ? null : v,
    z.enum(USER_SUFFIXES, { message: 'Invalid suffix' }).optional().nullable()
  ),
  username: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      'Username may only contain letters, numbers, dots, underscores, or hyphens'
    ),
  email:      emailField(),
  phone:      mobileField(),
  created_by: z.string().uuid().optional().nullable(),
})

export const coreUpdateFields = () => ({
  first_name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u,
      'First name must contain only letters, spaces, hyphens, or apostrophes'
    )
    .optional(),
  last_name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u,
      'Last name must contain only letters, spaces, hyphens, or apostrophes'
    )
    .optional(),
  middle_initial: z
    .string()
    .max(1)
    .regex(/^[\p{L}]$/u, 'Middle initial must be a letter')
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),
  suffix: z.preprocess(
    v => v === '' ? null : v,
    z.enum(USER_SUFFIXES, { message: 'Invalid suffix' }).optional().nullable()
  ),
  username: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      'Username may only contain letters, numbers, dots, underscores, or hyphens'
    )
    .optional(),
  email: emailField().optional(),
  phone: mobileField().optional(),
})