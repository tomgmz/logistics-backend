import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

export const createClientSchema = z.object({
  first_name: z
    .string({ error: 'First name is required' })
    .min(2, 'First name must be at least 2 characters')
    .max(50, 'First name is too long')
    .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes'),

  last_name: z
    .string({ error: 'Last name is required' })
    .min(2, 'Last name must be at least 2 characters')
    .max(50, 'Last name is too long')
    .regex(/^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u, 'Last name must contain only letters, spaces, hyphens, or apostrophes'),

  middle_initial: z
    .string()
    .max(1, 'Middle initial must be a single character')
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),

  suffix: z.preprocess(
    v => v === '' ? null : v,
    z.enum(USER_SUFFIXES, { error: 'Invalid suffix' }).optional().nullable()
  ),

  username: z
    .string({ error: 'Username is required' })
    .min(2, 'Username must be at least 2 characters')
    .max(50, 'Username is too long'),

  email: z
    .string({ error: 'Email is required' })
    .email('Invalid email address'),

  phone: z
    .string({ error: 'Phone is required' })
    .regex(
      /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/,
      'Phone must be a valid PH mobile (+639XXXXXXXXX) or landline (+63XXXXXXXXX)'
    ),

  landline: z
    .string()
    .regex(
      /^\+63[0-9]{9}$/,
      'Landline must be a valid PH landline'
    )
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),

  created_by: z.string().uuid().optional().nullable(),

  company_name: z
    .string({ error: 'Company name is required' })
    .min(1, 'Company name is required')
    .max(100, 'Company name is too long'),

  billing_address: z
    .string({ error: 'Billing address is required' })
    .min(1, 'Billing address is required'),

  payment_terms: z.number().int().positive().default(30).optional(),
})

export const updateClientSchema = z.object({
  first_name: z
    .string()
    .min(2, 'First name must be at least 2 characters')
    .max(50, 'First name is too long')
    .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes')
    .optional(),

  last_name: z
    .string()
    .min(2, 'Last name must be at least 2 characters')
    .max(50, 'Last name is too long')
    .regex(/^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u, 'Last name must contain only letters, spaces, hyphens, or apostrophes')
    .optional(),

  middle_initial: z
    .string()
    .max(1, 'Middle initial must be a single character')
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),

  suffix: z
    .string()
    .max(10)
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),

  username: z
    .string()
    .min(2, 'Username must be at least 2 characters')
    .max(50, 'Username is too long')
    .optional(),

  email: z
    .string()
    .email('Invalid email address')
    .optional(),

  phone: z
    .string()
    .regex(
      /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/,
      'Phone must be a valid PH mobile (+639XXXXXXXXX)'
    )
    .optional()
    .transform(v => v === '' ? null : v),

  landline: z
    .string()
    .regex(
      /^\+63[0-9]{9}$/,
      'Landline must be a valid PH landline'
    )
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),

  company_name:    z.string().max(100, 'Company name is too long').optional(),
  billing_address: z.string().optional(),
  payment_terms:   z.number().int().positive().optional(),
})