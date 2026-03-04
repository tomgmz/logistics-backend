import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

export const createSubcontractorSchema = z.object({
  first_name:     z.string().min(2).max(50)
                  .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes'),
  last_name:      z.string().min(2).max(50)
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
        .min(7, 'Phone number is too short')
        .max(15, 'Phone number exceeds maximum length')
        .regex(/^\+?[0-9\s\-().]+$/, 'Invalid phone number format')
        .optional()
        .nullable()
        .transform(v => v === '' ? null : v),
  created_by:     z.string().uuid().optional().nullable(),

  subcontractor_type: z.enum(['individual', 'company']),
  company_name:       z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
  business_permit:    z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
})

export const updateSubcontractorSchema = z.object({
  first_name:     z.string().min(2).max(50)
                  .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes')
                  .optional(),
  last_name:      z.string().min(2).max(50)
                  .regex(/^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u, 'Last name must contain only letters, spaces, hyphens, or apostrophes')
                  .optional(),
  middle_initial: z.string().max(1).optional().nullable().transform(v => v === '' ? null : v),
  suffix:         z.string().max(10).optional().nullable().transform(v => v === '' ? null : v),
  username:       z.string().min(2).max(50).optional(),
  email:          z.string().email().optional(),
  phone:          z.string().min(11).max(13)
                  .regex(/^\d+$/, 'Phone number must contain only digits')
                  .regex(/^09\d{9}$/, 'Invalid PH mobile format')
                  .optional()
                  .transform(v => v === '' ? null : v),

  subcontractor_type: z.enum(['individual', 'company']).optional(),
  company_name:       z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
  business_permit:    z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
})