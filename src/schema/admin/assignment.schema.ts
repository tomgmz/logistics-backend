import { z } from 'zod'

export const assignBookingSchema = z.object({
  driver_id: z.string().uuid('driver_id must be a valid UUID'),
  truck_id:  z.string().uuid('truck_id must be a valid UUID'),
})

export const updateDeliveryStatusSchema = z.object({
  status: z.enum(['pending', 'in_transit', 'completed', 'cancelled']),
  pickup_time:   z.string().datetime().optional(),
  delivery_time: z.string().datetime().optional(),
})

export type AssignBookingInput       = z.infer<typeof assignBookingSchema>
export type UpdateDeliveryStatusInput = z.infer<typeof updateDeliveryStatusSchema>