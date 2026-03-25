import { z } from 'zod'

export const createTruckModelSchema = z.object({
  name:               z.string().min(1, 'Name is required'),
  body_type:          z.string().optional().nullable(),
  dimension_mm:       z.string().optional().nullable(),
  suitable_for:       z.string().optional().nullable(),
  stackable_friendly: z.boolean().default(false),
  max_volume_cbm:     z.number().positive().optional().nullable(),
  max_weight_kg:      z.number().positive().optional().nullable(),
  max_length_cm:      z.number().positive().optional().nullable(),
  image_url:          z.string().url('image_url must be a valid URL'),
})

export const updateTruckModelSchema = z.object({
  name:               z.string().min(1).optional(),
  body_type:          z.string().optional().nullable(),
  dimension_mm:       z.string().optional().nullable(),
  suitable_for:       z.string().optional().nullable(),
  stackable_friendly: z.boolean().optional(),
  max_volume_cbm:     z.number().positive().optional().nullable(),
  max_weight_kg:      z.number().positive().optional().nullable(),
  max_length_cm:      z.number().positive().optional().nullable(),
  image_url:          z.string().url('image_url must be a valid URL').optional(),
})