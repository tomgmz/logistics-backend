import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

const phoneRegex   = /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/
const phoneMessage = 'Phone must be a valid PH mobile (+639XXXXXXXXX) or landline (+63XXXXXXXXX)'

export const createITAdminSchema = z.object({
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
  email: z.string().email(),
  phone: z
    .string()
    .regex(phoneRegex, phoneMessage),
  created_by: z.string().uuid().optional().nullable(),
})

export const updateITAdminSchema = z.object({
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
  email: z.string().email().optional(),
  phone: z
    .string()
    .regex(phoneRegex, phoneMessage)
    .optional(),
})