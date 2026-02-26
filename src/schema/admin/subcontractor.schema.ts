import { z } from 'zod'

export const createSubcontractorSchema = z.object({
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
  middle_initial: z.string().max(1).optional().nullable(),
  suffix:         z.string().max(10).optional().nullable(),
  username:       z.string().min(2).max(50),
  email:          z.string().email(),
  password:       z.string().min(8),
  phone:          z
                  .string()
                  .min(11, "Phone number must be at least 11 digits")
                  .max(13)
                  .regex(/^\d+$/, "Phone number must contain only digits")
                  .regex(/^09\d{9}$/, "Invalid PH mobile format"),
  created_by:     z.string().uuid().optional().nullable(), //nullable only for testing
})

export const updateSubcontractorSchema = z.object({
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
  middle_initial: z.string().max(1).optional().nullable(),
  suffix:         z.string().max(10).optional().nullable(),
  username:       z.string().min(2).max(50).optional(),
  email:          z.string().email().optional(),
  phone:          z
                  .string()
                  .min(11, "Phone number must be at least 11 digits")
                  .max(13)
                  .regex(/^\d+$/, "Phone number must contain only digits")
                  .regex(/^09\d{9}$/, "Invalid PH mobile format"),
})