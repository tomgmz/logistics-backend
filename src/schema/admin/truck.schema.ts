import { z } from 'zod'

export const createTruckSchema = z.object({
  plate_number:     z.string().min(1).max(20)
                    .regex(/^[A-Z0-9-]+$/, 'Plate number must contain only uppercase letters, numbers, or hyphens'),
  truck_type:       z.string().min(1).max(50),
  capacity_tons:    z.number().positive('Capacity must be a positive number'),
  owned_by:         z.enum(['company', 'subcontractor']).default('company'),
  subcontractor_id: z.string().uuid().optional().nullable(),
}).refine(
  (data) => data.owned_by === 'company' || !!data.subcontractor_id,
  {
    path: ['subcontractor_id'],
    message: 'Subcontractor ID is required when owned_by is subcontractor',
  }
)

export const updateTruckSchema = z.object({
  plate_number:     z.string().min(1).max(20)
                    .regex(/^[A-Z0-9-]+$/, 'Plate number must contain only uppercase letters, numbers, or hyphens')
                    .optional(),
  truck_type:       z.string().min(1).max(50).optional(),
  capacity_tons:    z.number().positive('Capacity must be a positive number').optional(),
  status:           z.enum(['available', 'in_use', 'under_maintenance', 'inactive']).optional(),
  owned_by:         z.enum(['company', 'subcontractor']).optional(),
  subcontractor_id: z.string().uuid().optional().nullable(),
})