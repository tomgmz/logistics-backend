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
  middle_name: z
                  .string()
                  .optional()
                  .nullable()
                  .transform(v => (v === '' ? null : v))
                  .refine(v => v == null || v.length >= 2,  'Middle name must be at least 2 characters')
                  .refine(v => v == null || v.length <= 50, 'Middle name is too long')
                  .refine(
                    v => v == null || /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(v),
                    'Middle name must contain only letters, spaces, hyphens, or apostrophes',
                  ),
  suffix: z.preprocess(
          (v) => {
            if (typeof v !== 'string') return v
            const normalized = v.trim().toLowerCase()
            return normalized === '' || normalized === 'n/a' || normalized === 'na' || normalized === 'none' || normalized === 'not applicable'
              ? null
              : v
          },
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
  middle_name: z
                  .string()
                  .optional()
                  .nullable()
                  .transform(v => (v === '' ? null : v))
                  .refine(v => v == null || v.length >= 2,  'Middle name must be at least 2 characters')
                  .refine(v => v == null || v.length <= 50, 'Middle name is too long')
                  .refine(
                    v => v == null || /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(v),
                    'Middle name must contain only letters, spaces, hyphens, or apostrophes',
                  ),
  suffix: z.preprocess(
          (v) => {
            if (typeof v !== 'string') return v
            const normalized = v.trim().toLowerCase()
            return normalized === '' || normalized === 'n/a' || normalized === 'na' || normalized === 'none' || normalized === 'not applicable'
              ? null
              : v
          },
          z.string().max(10).optional().nullable(),
        ),
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