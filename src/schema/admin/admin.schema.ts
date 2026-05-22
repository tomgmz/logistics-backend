import { z } from 'zod'

export const createAdminSchema = z.object({
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
  middle_name: z.string().regex(/^[A-Za-z]{1,2}$/, 'Middle initial must be 1–2 letters only').max(2).optional().nullable().transform(v => v === '' ? null : v),
  suffix: z.preprocess(
          v => v === '' ? null : v,
          z.string()
            .max(20, 'Suffix is too long')
            .regex(/^[\p{L}0-9 .,'-]*$/u, 'Suffix may only contain letters, numbers, spaces, periods, commas, apostrophes, or hyphens')
            .optional()
            .nullable(),
        ),
  email:          z.string().email(),
  phone: z
        .string()
        .regex(
          /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/,
          'Phone must be a valid PH mobile (+639XXXXXXXXX) or landline (+63XXXXXXXXX)'
        )
        .optional()
        .transform(v => v === '' ? null : v),
  created_by:     z.string().uuid().optional().nullable(),
})

export const updateAdminSchema = z.object({
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
  middle_name: z.string().max(1).optional().nullable(),
  suffix:         z.string().max(10).optional().nullable(),
  email:          z.string().email().optional(),
  phone: z
        .string()
        .regex(
          /^\+63(9[0-9]{9}|[2-8][0-9]{8})$/,
          'Phone must be a valid PH mobile (+639XXXXXXXXX) or landline (+63XXXXXXXXX)'
        )
        .optional()
        .transform(v => v === '' ? null : v),
})