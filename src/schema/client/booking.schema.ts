import { z } from 'zod'

export const createCargoItemSchema = z.object({
  commodity_id:   z.string().uuid().optional(),
  commodity_text: z.string().max(200).optional(),
  product_id:     z.string().uuid().optional(),
  product_text:   z.string().max(200).optional(),
  shc_id:         z.string().uuid().optional(),
  shc_text:       z.string().max(50).optional(),
  ashc_id:        z.string().uuid().optional(),
  ashc_text:      z.string().max(50).optional(),
  quantity:       z.number().positive().optional(),
  weight_kg:      z.number().min(0).optional(),
  volume_cbm:     z.number().min(0).optional(),
  length_cm:      z.number().min(0).optional(),
  width_cm:       z.number().min(0).optional(),
  height_cm:      z.number().min(0).optional(),
  notes:          z.string().optional(),
}).refine(
  (d) => !(d.commodity_id && d.commodity_text),
  { message: 'Provide either commodity_id or commodity_text, not both' }
).refine(
  (d) => !(d.product_id && d.product_text),
  { message: 'Provide either product_id or product_text, not both' }
).refine(
  (d) => !(d.shc_id && d.shc_text),
  { message: 'Provide either shc_id or shc_text, not both' }
).refine(
  (d) => !(d.ashc_id && d.ashc_text),
  { message: 'Provide either ashc_id or ashc_text, not both' }
)

export const updateCargoItemSchema = createCargoItemSchema

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
  delivered_at:   z.string().datetime().optional().nullable(),
  notes:          z.string().optional(),
  longitude:      z.number().optional().nullable(),
  latitude:       z.number().optional().nullable(),
})

export const updateDestinationStatusSchema = z.object({
  status:       z.enum(['pending', 'delivered', 'failed']),
  delivered_at: z.string().datetime().optional(),
})


export const createBookingSchema = z.object({
  client_id:             z.string().uuid(),
  origin:                z.string().min(1, 'Origin is required'),
  origin_longitude:      z.number().optional(),
  origin_latitude:       z.number().optional(),
  truck_type_needed:     z.string().min(1, 'Truck type is required'),
  schedule_date:         z.string().date(),
  call_time:             z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'call_time must be in HH:MM format'),
  required_volume_cbm:   z.number().min(0).optional(),
  required_weight_kg:    z.number().min(0).optional(),
  required_length_cm:    z.number().min(0).optional(),
  stackable_required:    z.boolean().optional(),
  payment_terms:         z.string().optional(),
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
  cargo_items: z.array(createCargoItemSchema).optional(),
})

export const updateBookingSchema = z.object({
  origin:                z.string().min(1).optional(),
  origin_longitude:      z.number().optional().nullable(),
  origin_latitude:       z.number().optional().nullable(),
  truck_type_needed:     z.string().min(1).optional(),
  schedule_date:         z.string().date().optional(),
  call_time:             z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'call_time must be in HH:MM format').optional(),
  required_volume_cbm:   z.number().min(0).optional().nullable(),
  required_weight_kg:    z.number().min(0).optional().nullable(),
  required_length_cm:    z.number().min(0).optional().nullable(),
  stackable_required:    z.boolean().optional().nullable(),
  payment_terms:         z.string().optional().nullable(),
  transaction_documents: z.array(z.string().url()).min(1).max(3).optional().nullable(),
})

export const updateBookingStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'assigned', 'in_transit', 'completed', 'cancelled']),
})


export const accountingReviewSchema = z.object({
  accounting_status: z.enum(['approved', 'rejected', 'forwarded']),
  rejection_reason:  z.string().min(1).optional(),
}).refine(
  (data) => data.accounting_status !== 'rejected' || !!data.rejection_reason,
  { message: 'rejection_reason is required when rejecting', path: ['rejection_reason'] }
)

export const gmReviewSchema = z.object({
  gm_status:        z.enum(['approved', 'rejected']),
  rejection_reason: z.string().min(1).optional(),
}).refine(
  (data) => data.gm_status !== 'rejected' || !!data.rejection_reason,
  { message: 'rejection_reason is required when rejecting', path: ['rejection_reason'] }
)

export const opsAssignSchema = z.object({
  ops_status: z.literal('assigned'),
})

// The 10 BLOWBAGETS inspection items. Every key is required so a partial/renamed
// payload is rejected at the boundary.
export const blowbagetsSchema = z.object({
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
})

export const fleetReviewSchema = z.object({
  decision:         z.enum(['approved', 'rejected']),
  rejection_reason: z.string().min(1).optional(),
  blowbagets:       blowbagetsSchema.optional(),
}).refine(
  (data) => data.decision !== 'rejected' || !!data.rejection_reason,
  { message: 'rejection_reason is required when rejecting', path: ['rejection_reason'] }
).refine(
  // Approval demands a complete, all-passing inspection — enforced here so the
  // rule holds even if a client bypasses the UI gate.
  (data) => data.decision !== 'approved' || (!!data.blowbagets && Object.values(data.blowbagets).every(Boolean)),
  { message: 'All BLOWBAGETS items must be checked before the vehicle can be approved', path: ['blowbagets'] }
)