import { z } from 'zod'

export const TRUCK_TYPES = ['truck', 'wing_van'] as const
export type TruckType = typeof TRUCK_TYPES[number]

export const createTruckSchema = z.object({
  plate_number:     z
                    .string()
                    .toUpperCase()
                    .regex(
                      /^(?:[A-Z]{3}[ -]?\d{4}|[A-Z]{2,3}[ -]?\d{2,3})$/,
                      'Invalid PH plate format (e.g. ABC 1234 or AB 1234)'
                    ),
  truck_type:       z.enum(TRUCK_TYPES, { message: 'Invalid truck type' }),
  capacity_tons:    z.number().positive('Capacity must be a positive number'),
  model_id:         z.string().uuid().optional().nullable(),
  owned_by:   z.enum(['company', 'vendor']).default('company'),
  vendor_id:  z.string().uuid().optional().nullable(),
}).refine(
  (data) => data.owned_by === 'company' || !!data.vendor_id,
  {
    path: ['vendor_id'],
    message: 'Vendor ID is required when owned_by is vendor',
  }
)

export const updateTruckSchema = z.object({
  plate_number:     z
                    .string()
                    .toUpperCase()
                    .regex(
                      /^(?:[A-Z]{3}[ -]?\d{4}|[A-Z]{2,3}[ -]?\d{2,3})$/,
                      'Invalid PH plate format (e.g. ABC 1234 or AB 1234)'
                    )
                    .optional(),
  truck_type:       z.enum(TRUCK_TYPES, { message: 'Invalid truck type' }).optional(),
  capacity_tons:    z.number().positive('Capacity must be a positive number').optional(),
  model_id:         z.string().uuid().optional().nullable(),
  status:     z.enum(['available', 'in_use', 'under_maintenance', 'inactive', 'archived']).optional(),
  owned_by:   z.enum(['company', 'vendor']).optional(),
  vendor_id:  z.string().uuid().optional().nullable(),
})