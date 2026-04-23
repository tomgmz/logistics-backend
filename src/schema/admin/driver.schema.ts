import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

export const createDriverSchema = z.object({
  first_name:     z
                  .string()
                  .min(2)
                  .max(50)
                  .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes'),
  last_name:      z
                  .string()
                  .min(2)
                  .max(50)
                  .regex(/^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u, 'Last name must contain only letters, spaces, hyphens, or apostrophes'),
  middle_initial: z.string().max(1).optional().nullable().transform(v => v === '' ? null : v),
  suffix: z
        .preprocess(
          v => v === '' ? null : v,
          z.enum(USER_SUFFIXES, { message: 'Invalid suffix' }).optional().nullable()
        ),
  username:       z.string().min(2).max(50),
  email:          z.string().email(),
  password:       z.string().min(8),
  phone: z
        .string()
        .regex(
          /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/,
          'Phone must be a valid PH mobile (+639XXXXXXXXX) or landline (+63XXXXXXXXX)'
        )
        .transform(v => v === '' ? null : v),
  created_by:     z.string().uuid().optional().nullable(),

  license_number: z
                .string()
                .regex(/^[A-Z]\d{2}-\d{2}-\d{6}$/, 'Invalid LTO license number format (e.g. A01-23-456789)'),
  license_expiry: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)')
                .refine(val => {
                  const date = new Date(val)
                  return !isNaN(date.getTime())
                }, 'Invalid date')
                .refine(val => {
                  return new Date(val) > new Date()
                }, 'License is already expired'),
  is_vendor_driver: z.boolean().optional().default(false),
  vendor_id:        z.string().uuid().optional().nullable(),
}).refine(
  (data) => !data.is_vendor_driver || !!data.vendor_id,
  {
    path: ['vendor_id'],
    message: 'Vendor ID is required when driver is a vendor driver',
  }
)

export const updateDriverSchema = z.object({
  first_name:     z
                  .string()
                  .min(2)
                  .max(50)
                  .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes')
                  .optional(),
  last_name:      z
                  .string()
                  .min(2)
                  .max(50)
                  .regex(/^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u, 'Last name must contain only letters, spaces, hyphens, or apostrophes')
                  .optional(),
  middle_initial:   z.string().max(1).optional().nullable().transform(v => v === '' ? null : v),
  suffix:           z.string().max(10).optional().nullable().transform(v => v === '' ? null : v),
  username:         z.string().min(2).max(50).optional(),
  email:            z.string().email().optional(),
  phone: z
        .string()
        .regex(
          /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/,
          'Phone must be a valid PH mobile (+639XXXXXXXXX) or landline (+63XXXXXXXXX)'
        )
        .optional()
        .transform(v => v === '' ? null : v),
  license_number:   z.string().min(1).max(50).optional(),
  license_expiry:   z.string().optional(),
  is_vendor_driver: z.boolean().optional(),
  vendor_id:        z.string().uuid().optional().nullable(),
}).refine(
  (data) => {
    if (data.is_vendor_driver === true) return !!data.vendor_id
    return true
  },
  {
    path: ['vendor_id'],
    message: 'Vendor ID is required when driver is a vendor driver',
  }
)