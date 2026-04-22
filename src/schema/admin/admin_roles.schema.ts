import { z } from 'zod'
import { USER_SUFFIXES } from '../../types/user.types.js'

const nameFields = {
  first_name: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes'),
  last_name: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[\p{L}](?:[\p{L}'-]*[\p{L}])?(?: [\p{L}'-]+[\p{L}])*$/u, 'Last name must contain only letters, spaces, hyphens, or apostrophes'),
  middle_initial: z.string().max(1).optional().nullable().transform(v => v === '' ? null : v),
  suffix: z.preprocess(
    v => v === '' ? null : v,
    z.enum(USER_SUFFIXES, { message: 'Invalid suffix' }).optional().nullable()
  ),
  username:   z.string().min(2).max(50),
  email:      z.string().email(),
  phone: z
    .string()
    .min(8, 'Phone number is too short')
    .max(16, 'Phone number is too long')
    .regex(/^\+[0-9]+$/, 'Invalid phone number format')
    .optional()
    .nullable()
    .transform(v => v === '' ? null : v),
  created_by: z.string().uuid().optional().nullable(),
}

const updateNameFields = {
  first_name: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u, 'First name must contain only letters, spaces, hyphens, or apostrophes')
    .optional(),
  last_name: z
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
}

// ── Human Resources ──────────────────────────────────────────────────────────
export const createHumanResourcesSchema = z.object(nameFields)
export const updateHumanResourcesSchema = z.object(updateNameFields)

// ── Fleet Admin ───────────────────────────────────────────────────────────────
export const createFleetAdminSchema = z.object(nameFields)
export const updateFleetAdminSchema = z.object(updateNameFields)

// ── Operations Admin ──────────────────────────────────────────────────────────
export const createOperationsAdminSchema = z.object(nameFields)
export const updateOperationsAdminSchema = z.object(updateNameFields)