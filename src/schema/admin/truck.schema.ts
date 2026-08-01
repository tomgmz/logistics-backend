import { z } from 'zod'

const PLATE_REGEX = /^(?:[A-ZÑ]{3} ?\d{4}|[A-ZÑ]{2,3} ?\d{2,3})$/

export const createTruckSchema = z.object({
  plate_number: z
    .string()
    .toUpperCase()
    .regex(
      PLATE_REGEX,
      'Invalid PH plate format (e.g. ABC 1234). Only letters, and numbers are allowed.',
    ),
  model_id:  z.string().uuid().optional().nullable(),
})

export const updateTruckSchema = z.object({
  plate_number: z
    .string()
    .toUpperCase()
    .regex(
      PLATE_REGEX,
      'Invalid PH plate format (e.g. ABC 1234). Only letters, and numbers are allowed.',
    )
    .optional(),
  model_id:  z.string().uuid().optional().nullable(),
  status:    z.enum(['available', 'in_use', 'under_maintenance', 'inactive', 'archived']).optional(),
})