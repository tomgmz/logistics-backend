import { z } from 'zod'

export const createDestinationSchema = z.object({
  address:        z.string().min(1, 'Address is required'),
  sequence_order: z.number().int().positive(),
  notes:          z.string().optional(),
  longitude:      z.number().optional(),
  latitude:       z.number().optional(),
})

export const updateDestinationSchema = z.object({
  address:        z.string().min(1).optional(),
  sequence_order: z.number().int().positive().optional(),
  status:         z.enum(['pending', 'delivered', 'failed']).optional(),
  delivered_at:   z.string().datetime().optional(),
  notes:          z.string().optional(),
  longitude:      z.number().optional().nullable(),
  latitude:       z.number().optional().nullable(),
})

export const createBookingSchema = z.object({
  client_id:             z.string().uuid(),
  origin:                z.string().min(1, 'Origin is required'),
  origin_longitude:      z.number().optional(),
  origin_latitude:       z.number().optional(),
  truck_type_needed:     z.string().min(1, 'Truck type is required'),
  cargo_details:         z.string().optional(),
  schedule_date:         z.string().date(),
  call_time:             z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'call_time must be in HH:MM format'),
  required_volume_cbm:   z.number().positive().optional(),
  required_weight_kg:    z.number().positive().optional(),
  required_length_cm:    z.number().positive().optional(),
  stackable_required:    z.boolean().optional(),
  payment_terms:         z.string(),
  transaction_documents: z.array(z.string().url()).min(1, 'At least one transaction document is required').max(3),
  destinations: z.array(createDestinationSchema)
    .min(1, 'At least one destination is required')
    .refine(
      (destinations) => {
        const orders = destinations.map((d) => d.sequence_order)
        return new Set(orders).size === orders.length
      },
      { message: 'sequence_order must be unique per destination' }
    ),
})

export const updateBookingSchema = z.object({
  origin:              z.string().min(1).optional(),
  origin_longitude:    z.number().optional().nullable(),
  origin_latitude:     z.number().optional().nullable(),
  truck_type_needed:   z.string().min(1).optional(),
  cargo_details:       z.string().optional(),
  schedule_date:       z.string().date().optional(),
  call_time:           z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'call_time must be in HH:MM format').optional(),
  status:              z.enum(['pending', 'assigned', 'in_transit', 'completed', 'cancelled']).optional(),
  required_volume_cbm: z.number().positive().optional().nullable(),
  required_weight_kg:  z.number().positive().optional().nullable(),
  required_length_cm:  z.number().positive().optional().nullable(),
  stackable_required:  z.boolean().optional().nullable(),
  payment_terms:         z.string().optional().nullable(),
  transaction_documents: z.array(z.string().url()).min(1).max(3).optional().nullable(),
})

export const updateBookingStatusSchema = z.object({
  status: z.enum(['pending', 'assigned', 'in_transit', 'completed', 'cancelled']),
})

export const updateDestinationStatusSchema = z.object({
  status:       z.enum(['pending', 'delivered', 'failed']),
  delivered_at: z.string().datetime().optional(),
})