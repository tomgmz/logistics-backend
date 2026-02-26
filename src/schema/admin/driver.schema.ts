import { z } from 'zod'

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
  suffix:         z.string().max(10).optional().nullable().transform(v => v === '' ? null : v),
  username:       z.string().min(2).max(50),
  email:          z.string().email(),
  password:       z.string().min(8),
  phone:          z
                  .string()
                  .min(11, "Phone number must be at least 11 digits")
                  .max(13)
                  .regex(/^\d+$/, "Phone number must contain only digits")
                  .regex(/^09\d{9}$/, "Invalid PH mobile format"),
  created_by:     z.string().uuid().optional().nullable(),

  license_number:          z.string().min(1).max(50),
  license_expiry:          z.string().min(1),
  is_subcontractor_driver: z.boolean().optional().default(false),
  subcontractor_id:        z.string().uuid().optional().nullable(),
}).refine(
  (data) => !data.is_subcontractor_driver || !!data.subcontractor_id,
  {
    path: ['subcontractor_id'],
    message: 'Subcontractor ID is required when driver is a subcontractor driver',
  }
)

export const updateDriverSchema = z.object({
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
  middle_initial:          z.string().max(1).optional().nullable().transform(v => v === '' ? null : v),
  suffix:                  z.string().max(10).optional().nullable().transform(v => v === '' ? null : v),
  username:                z.string().min(2).max(50).optional(),
  email:                   z.string().email().optional(),
  phone:                   z
                           .string()
                           .min(11, "Phone number must be at least 11 digits")
                           .max(13)
                           .regex(/^\d+$/, "Phone number must contain only digits")
                           .regex(/^09\d{9}$/, "Invalid PH mobile format"),
  license_number:          z.string().min(1).max(50).optional(),
  license_expiry:          z.string().optional(),
  is_subcontractor_driver: z.boolean().optional(),
  subcontractor_id:        z.string().uuid().optional().nullable(),
}).refine(
  (data) => !data.is_subcontractor_driver || !!data.subcontractor_id,
  {
    path: ['subcontractor_id'],
    message: 'Subcontractor ID is required when driver is a subcontractor driver',
  }
)