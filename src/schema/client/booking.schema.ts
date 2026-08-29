import { z } from 'zod'
import { MAX_DESTINATIONS_PER_BOOKING } from '../../lib/booking-limits.js'

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
  // Optional because it is ignored for the only role that can call this route:
  // a client's booking is attributed to the company on their session, never to
  // whatever the body claims. Still uuid-checked so garbage is refused outright.
  client_id:             z.string().uuid().optional(),
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
  // One to three drop-offs per booking: a single trip carries at most three, and
  // the driver app's stop flow (pickup -> drop-offs -> done) is built to that.
  // The client wizard already caps its UI at 3; this is the API-side rule.
  destinations: z.array(createDestinationSchema)
    .min(1, 'At least one destination is required')
    .max(MAX_DESTINATIONS_PER_BOOKING, `A booking can have at most ${MAX_DESTINATIONS_PER_BOOKING} drop-offs`)
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

// Stop confirmations from the driver app carry the proof photo the driver took
// at that stop (already uploaded via POST /driver/proof-photo).
export const driverStopProofSchema = z.object({
  proof_photo_url: z.string().url('A proof photo is required to confirm this stop'),
  // Set by the app when the driver has deliberately chosen to run a booking
  // ahead of its scheduled day. Only the pickup consults it; it is recorded in
  // the audit log so an early start is never silent.
  early_start: z.boolean().optional(),

  // Where the driver was when they confirmed, captured on the device at that
  // moment. It has to travel in the body rather than being read server-side:
  // confirmations queue offline and may arrive hours later, from somewhere else
  // entirely, so a position measured on arrival is the only one that means
  // anything. Optional so a phone with no fix can still reach the gate and be
  // told what is wrong, instead of failing validation with nothing to show.
  latitude:   z.number().min(-90).max(90).optional(),
  longitude:  z.number().min(-180).max(180).optional(),
  accuracy_m: z.number().nonnegative().optional(),

  // The driver's stated reason for confirming a stop the distance gate would
  // have refused. Recorded on the stop and flagged to operations.
  override_reason: z.string().trim().min(3).max(300).optional(),
})

// A single position ping from the driver app while a booking is in transit.
//
// Unlike a stop confirmation this is disposable: the app sends these constantly,
// never queues them, and drops any that fail. So the position is required here
// (a ping with no coordinates is nothing) while `recorded_at` carries the
// device's own timestamp — the service refuses fixes that are too old to be
// worth drawing, and it can only know that if the device says when it looked.
export const driverLocationPingSchema = z.object({
  latitude:    z.number().min(-90).max(90),
  longitude:   z.number().min(-180).max(180),
  accuracy_m:  z.number().nonnegative().max(10_000).optional().nullable(),
  // Metres per second, straight off the platform's location object. Negative is
  // how both iOS and Android report "unknown", so it is normalised away rather
  // than rejected — a ping is still useful without it.
  speed_mps:   z.number().min(-1).max(90).optional().nullable(),
  heading_deg: z.number().min(-1).max(360).optional().nullable(),
  recorded_at: z.string().datetime({ offset: true }),
})

export const updateBookingStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'assigned', 'in_transit', 'completed', 'cancelled']),
  // The administrator's remarks when rejecting a booking outright. Optional —
  // this endpoint also drives ordinary lifecycle moves that carry no remarks.
  rejection_reason: z.string().min(1).max(500).optional(),
})


// The general manager's decision — the single approval gate on a booking. A
// rejection must carry the GM's remarks; the client sees them in the rejection
// notification and on the booking record.
export const gmReviewSchema = z.object({
  gm_status:        z.enum(['approved', 'rejected']),
  rejection_reason: z.string().min(1).optional(),
}).refine(
  (data) => data.gm_status !== 'rejected' || !!data.rejection_reason?.trim(),
  { message: 'Remarks explaining the rejection are required', path: ['rejection_reason'] }
)

// The driver's plan for one calendar month, sent whole rather than as a diff:
// the calendar screen holds the month, so a save is "these are my days". The
// service ignores days that have already passed.
export const driverAvailabilityDaysSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
  days:  z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'days must be YYYY-MM-DD')).max(31),
})