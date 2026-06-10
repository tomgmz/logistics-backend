import { z } from 'zod'

// Capitalize the first letter of each word (start, space, hyphen, apostrophe), leaving the rest as entered.
const toNameCase = (v: string): string =>
  v.replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())

const emailRegex =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|[._%+-](?=[a-zA-Z0-9]))*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/

export const emailField = () =>
  z
    .string()
    .min(5, 'Email is too short')
    .max(254, 'Email is too long')
    .regex(emailRegex, 'Invalid email address')
    .refine(
      v => v.split('@')[0].length <= 64,
      'Email local part is too long',
    )
    .refine(v => {
      const domain = v.split('@')[1]
      if (!domain) return true  
      const parts  = domain.split('.')
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === parts[i + 1]) return false
      }
      return true
    }, 'Invalid domain')
    .transform(v => v.trim().toLowerCase())

export const mobileField = () =>
  z
    .string()
    .regex(
      /^\+639[0-9]{9}$/,
      'Phone must be a valid PH mobile number (+639XXXXXXXXX)',
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
    .refine(val => isNaN(new Date(val).getTime()) || new Date(val) > new Date(), 'License is already expired')

export const coreCreateFields = () => ({
  first_name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[\p{L}]+\.?(?:[ '-][\p{L}]+\.?)*$/u,
      'First name must contain only letters, spaces, hyphens, or apostrophes',
    )
    .transform(toNameCase),
  last_name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u,
      'Last name must contain only letters, spaces, hyphens, or apostrophes',
    )
    .transform(toNameCase),
  middle_name: z
    .string()
    .optional()
    .nullable()
    .transform(v => (v === '' ? null : v))
    .refine(
      v => v == null || v.length >= 2,
      'Middle name must be at least 2 characters',
    )
    .refine(
      v => v == null || v.length <= 50,
      'Middle name is too long',
    )
    .refine(
      v => v == null || /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(v),
      'Middle name must contain only letters, spaces, hyphens, or apostrophes',
    )
    .transform(v => (v == null ? v : toNameCase(v))),
  suffix: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v
      const normalized = v.trim().toLowerCase()
      return normalized === '' || normalized === 'n/a' || normalized === 'na' || normalized === 'none' || normalized === 'not applicable'
        ? null
        : v
    },
    z.string()
      .max(20, 'Suffix is too long')
      .regex(/^[\p{L}0-9 .,'-]*$/u, 'Suffix may only contain letters, numbers, spaces, periods, commas, apostrophes, or hyphens')
      .optional()
      .nullable(),
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
      /^[\p{L}]+\.?(?:[ '-][\p{L}]+\.?)*$/u,
      'First name must contain only letters, spaces, hyphens, or apostrophes',
    )
    .transform(toNameCase)
    .optional(),
  last_name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u,
      'Last name must contain only letters, spaces, hyphens, or apostrophes',
    )
    .transform(toNameCase)
    .optional(),
  middle_name: z
    .string()
    .optional()
    .nullable()
    .transform(v => (v === '' ? null : v))
    .refine(
      v => v == null || v.length >= 2,
      'Middle name must be at least 2 characters',
    )
    .refine(
      v => v == null || v.length <= 50,
      'Middle name is too long',
    )
    .refine(
      v => v == null || /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(v),
      'Middle name must contain only letters, spaces, hyphens, or apostrophes',
    )
    .transform(v => (v == null ? v : toNameCase(v))),
  suffix: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v
      const normalized = v.trim().toLowerCase()
      return normalized === '' || normalized === 'n/a' || normalized === 'na' || normalized === 'none' || normalized === 'not applicable'
        ? null
        : v
    },
    z.string()
      .max(20, 'Suffix is too long')
      .regex(/^[\p{L}0-9 .,'-]*$/u, 'Suffix may only contain letters, numbers, spaces, periods, commas, apostrophes, or hyphens')
      .optional()
      .nullable(),
  ),
  email: emailField().optional(),
  phone: mobileField().optional(),
})