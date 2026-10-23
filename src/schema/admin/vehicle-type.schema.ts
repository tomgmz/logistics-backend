import { z } from 'zod'

export const createVehicleTypeSchema = z.object({
  name:        z.string().trim().min(1, 'Name is required').max(60, 'Name must be at most 60 characters'),
  description: z.string().trim().max(300, 'Description must be at most 300 characters').nullable().optional(),
  is_active:   z.boolean().optional(),
}).strict()

export const updateVehicleTypeSchema = z.object({
  name:        z.string().trim().min(1, 'Name is required').max(60, 'Name must be at most 60 characters').optional(),
  description: z.string().trim().max(300, 'Description must be at most 300 characters').nullable().optional(),
  is_active:   z.boolean().optional(),
}).strict()
