import { z } from 'zod'

export const createTruckModelSchema = z.object({
  name:               z.string().min(1, 'Name is required'),
  vehicle_type:       z.string().min(1, 'Vehicle type is required'),
  length_mm:          z.coerce.number({ error: 'Length is required' }).positive('Length must be positive'),
  width_mm:           z.coerce.number({ error: 'Width is required' }).positive('Width must be positive'),
  height_mm:          z.coerce.number({ error: 'Height is required' }).positive('Height must be positive'),
  suitable_for:       z.string().min(1, 'Suitable for is required'),
  stackable_friendly: z.boolean().default(false),
  max_volume_cbm:     z.coerce.number({ error: 'Max volume is required' }).positive('Max volume must be positive'),
  max_weight_kg:      z.coerce.number({ error: 'Max weight is required' }).positive('Max weight must be positive'),
  max_length_cm:      z.coerce.number({ error: 'Max length is required' }).positive('Max length must be positive'),
  image_url:          z.string().url('image_url must be a valid URL'),
})

export const updateTruckModelSchema = z.object({
  name:               z.string().min(1).optional(),
  vehicle_type:       z.string().min(1).optional(),
  length_mm:          z.coerce.number().positive().optional(),
  width_mm:           z.coerce.number().positive().optional(),
  height_mm:          z.coerce.number().positive().optional(),
  suitable_for:       z.string().min(1).optional(),
  stackable_friendly: z.boolean().optional(),
  max_volume_cbm:     z.coerce.number().positive().optional(),
  max_weight_kg:      z.coerce.number().positive().optional(),
  max_length_cm:      z.coerce.number().positive().optional(),
  image_url:          z.string().url().optional(),
})

export type CreateTruckModelInput = z.infer<typeof createTruckModelSchema>
export type UpdateTruckModelInput = z.infer<typeof updateTruckModelSchema>