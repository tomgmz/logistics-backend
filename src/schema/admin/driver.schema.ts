import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

const phoneRegex = /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/
const phoneMessage = 'Phone must be a valid PH mobile (+639XXXXXXXXX) or landline (+63XXXXXXXXX)'

const licenseRegex   = /^[A-Z]\d{2}-\d{2}-\d{6}$/
const licenseMessage = 'Invalid LTO license number format (e.g. A01-23-456789)'

export const createDriverSchema = z.object({
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
  email:    z.string().email(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must include at least one uppercase letter')
    .regex(/[a-z]/, 'Password must include at least one lowercase letter')
    .regex(/[0-9]/, 'Password must include at least one number'),
  phone: z
    .string()
    .regex(phoneRegex, phoneMessage),
  created_by: z.string().uuid().optional().nullable(),
  license_number: z
    .string()
    .regex(licenseRegex, licenseMessage),
  license_expiry: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)')
    .refine(val => !isNaN(new Date(val).getTime()), 'Invalid date')
    .refine(val => new Date(val) > new Date(), 'License is already expired'),
  is_vendor_driver: z.boolean().optional().default(false),
  vendor_id:        z.string().uuid().optional().nullable(),
}).refine(
  data => !data.is_vendor_driver || !!data.vendor_id,
  { path: ['vendor_id'], message: 'Vendor ID is required when driver is a vendor driver' }
)

export const updateDriverSchema = z.object({
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
  email:    z.string().email().optional(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must include at least one uppercase letter')
    .regex(/[a-z]/, 'Password must include at least one lowercase letter')
    .regex(/[0-9]/, 'Password must include at least one number')
    .optional(),
  phone: z
    .string()
    .regex(phoneRegex, phoneMessage)
    .optional(),
  license_number: z
    .string()
    .regex(licenseRegex, licenseMessage)
    .optional(),
  license_expiry: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)')
    .refine(val => !isNaN(new Date(val).getTime()), 'Invalid date')
    .refine(val => new Date(val) > new Date(), 'License is already expired')
    .optional(),
  is_vendor_driver: z.boolean().optional(),
  vendor_id:        z.string().uuid().optional().nullable(),
}).refine(
  data => {
    if (data.is_vendor_driver === true) return !!data.vendor_id
    return true
  },
  { path: ['vendor_id'], message: 'Vendor ID is required when driver is a vendor driver' }
)