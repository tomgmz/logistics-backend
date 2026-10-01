import { z } from 'zod'

// Capitalize the first letter of each word (start, space, hyphen, apostrophe), leaving the rest as entered.
const toNameCase = (v: string): string =>
  v.replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())

const emailRegex =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|[._%+-](?=[a-zA-Z0-9]))*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/

export const emailField = () =>
  z
    .string()
    .trim()
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
    .trim()
    .regex(
      /^\+639[0-9]{9}$/,
      'Phone must be a valid PH mobile number (+639XXXXXXXXX)',
    )

// For forms where a phone is welcome but not required: blank means "none given".
export const optionalMobileField = () =>
  z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    mobileField().optional(),
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

// Single source for the person-name rules. Every schema that takes a name — the
// user forms, the vendor driver snapshot, the landing-page contact form — builds
// from these so a name accepted in one place is accepted everywhere.
const firstNameRegex = /^[\p{L}]+\.?(?:[ '-][\p{L}]+\.?)*$/u
const lastNameRegex  = /^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u
const middleNameRegex = /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u
// A whole name in one box ("Juan Dela Cruz Jr."): the first-name rule already
// allows words with a trailing period, so it covers a suffix like "Jr." or "III";
// only the length cap differs.
const fullNameRegex  = firstNameRegex

export const firstNameField = () =>
  z
    .string()
    .trim()
    .min(2, 'First name must be at least 2 characters')
    .max(50, 'First name is too long')
    .regex(firstNameRegex, 'First name must contain only letters, spaces, hyphens, or apostrophes')
    .transform(toNameCase)

export const lastNameField = () =>
  z
    .string()
    .trim()
    .min(2, 'Last name must be at least 2 characters')
    .max(50, 'Last name is too long')
    .regex(lastNameRegex, 'Last name must contain only letters, spaces, hyphens, or apostrophes')
    .transform(toNameCase)

export const middleNameField = () =>
  z
    .string()
    .optional()
    .nullable()
    .transform(v => (v == null ? v : v.trim() === '' ? null : v.trim()))
    .refine(v => v == null || v.length >= 2, 'Middle name must be at least 2 characters')
    .refine(v => v == null || v.length <= 50, 'Middle name is too long')
    .refine(
      v => v == null || middleNameRegex.test(v),
      'Middle name must contain only letters, spaces, hyphens, or apostrophes',
    )
    .transform(v => (v == null ? v : toNameCase(v)))

export const suffixField = () =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v
      const normalized = v.trim().toLowerCase()
      return normalized === '' || normalized === 'n/a' || normalized === 'na' || normalized === 'none' || normalized === 'not applicable'
        ? null
        : v.trim()
    },
    z.string()
      .max(20, 'Suffix is too long')
      .regex(/^[\p{L}0-9 .,'-]*$/u, 'Suffix may only contain letters, numbers, spaces, periods, commas, apostrophes, or hyphens')
      .optional()
      .nullable(),
  )

export const fullNameField = (label = 'Name') =>
  z
    .string()
    .trim()
    .min(2, `${label} must be at least 2 characters`)
    .max(100, `${label} is too long`)
    .regex(fullNameRegex, `${label} must contain only letters, spaces, hyphens, periods, or apostrophes`)
    .transform(toNameCase)

export const coreCreateFields = () => ({
  first_name:  firstNameField(),
  last_name:   lastNameField(),
  middle_name: middleNameField(),
  suffix:      suffixField(),
  email:       emailField(),
  phone:       mobileField(),
  created_by:  z.string().uuid().optional().nullable(),
})

export const coreUpdateFields = () => ({
  first_name:  firstNameField().optional(),
  last_name:   lastNameField().optional(),
  middle_name: middleNameField(),
  suffix:      suffixField(),
  email:       emailField().optional(),
  phone:       mobileField().optional(),
})
