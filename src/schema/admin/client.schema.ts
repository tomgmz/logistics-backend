import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

export const createClientSchema = z.object({
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
        .min(8, 'Phone number is too short')
        .max(16, 'Phone number is too long')
        .regex(/^\+?[0-9]+$/, 'Invalid phone number format')
        .optional()
        .nullable()
        .transform(v => v === '' ? null : v),
  created_by:     z.string().uuid().optional().nullable(), //nullable only for testing

  company_name:    z.string().max(100).optional(),
  billing_address: z.string().optional(),
  payment_terms:   z.number().int().positive().default(30).optional(),
})

export const updateClientSchema = z.object({
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
  middle_initial: z.string().max(1).optional().nullable().transform(v => v === '' ? null : v),
  suffix:         z.string().max(10).optional().nullable().transform(v => v === '' ? null : v),
  username:       z.string().min(2).max(50).optional(),
  email:          z.string().email().optional(),
  phone: z
        .string()
        .min(8, 'Phone number is too short')
        .max(16, 'Phone number is too long')
        .regex(/^\+[0-9]+$/, 'Invalid phone number format')
        .optional()
        .nullable()
        .transform(v => v === '' ? null : v),
  company_name:    z.string().max(100).optional(),
  billing_address: z.string().optional(),
  payment_terms:   z.number().int().positive().optional(),
})