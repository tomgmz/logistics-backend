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

// The fleet manager's BLOWBAGETS inspection of a vehicle. Every item must be
// reported (true = passed); the service derives the overall pass/fail from them.
export const recordTruckInspectionSchema = z.object({
  items: z.object({
    battery: z.boolean(),
    lights:  z.boolean(),
    oil:     z.boolean(),
    water:   z.boolean(),
    brakes:  z.boolean(),
    air:     z.boolean(),
    gas:     z.boolean(),
    engine:  z.boolean(),
    tires:   z.boolean(),
    self:    z.boolean(),
  }),
  notes: z.string().max(500).optional().nullable(),
})