import { z } from 'zod'
import { driverStopProofSchema } from './booking.schema.js'
import { PAUSE_REASONS } from '../../types/client/pause.types.js'

/**
 * Validation for the multi-trip driver flow.
 *
 * The stop confirmations reuse `driverStopProofSchema` unchanged: a trip's
 * pickup and a trip's drop-off carry exactly the same evidence as the
 * single-trip ones did — photo, position, and a reason when the driver forced a
 * confirmation the distance gate would have refused.
 */

export const tripStopProofSchema = driverStopProofSchema

/** One cargo line's quantity — on a planned stop, or as loaded at a pickup. */
const cargoQuantity = z.object({
  item_id:  z.string().uuid(),
  quantity: z.number().min(0).max(1_000_000),
})

/**
 * A run's pickup: the same evidence, plus what the driver actually loaded when
 * it differs from the plan. Omitted means "exactly as planned".
 */
export const tripPickupProofSchema = driverStopProofSchema.extend({
  loaded: z.array(cargoQuantity).max(200).optional(),
})

/** The driver's chosen drop-off order for one trip, as trip stop ids. */
export const tripStopOrderSchema = z.object({
  trip_stop_ids: z.array(z.string().uuid()).min(1).max(20),
})

/**
 * Operations' trip plan for a booking: how many runs the truck makes and which
 * drop-offs each run serves.
 *
 * A drop-off may appear on more than one trip — a bay whose load needs two runs
 * is the entire reason this exists — so no uniqueness is imposed across trips.
 * That every drop-off appears at least once IS required, but only the service
 * can check it: it needs the booking's own destinations to compare against.
 */
export const setTripPlanSchema = z.object({
  trips: z.array(z.object({
    trip_number:     z.number().int().positive().optional(),
    destination_ids: z.array(z.string().uuid())
      .min(1, 'Every trip must serve at least one drop-off')
      // A single run cannot unload at more bays than the booking has.
      .max(10),
    // How much of each cargo line this run carries, per drop-off. Optional: a
    // plan without it is the older whole-drop-off plan.
    stops: z.array(z.object({
      destination_id: z.string().uuid(),
      items:          z.array(cargoQuantity).max(100),
    })).max(10).optional(),
    notes: z.string().max(500).optional().nullable(),
  }))
    .min(1, 'A booking needs at least one trip')
    // Ten runs of one truck is already an extreme day; beyond that the booking
    // should have been split.
    .max(10, 'A booking cannot be planned as more than 10 trips'),
})

/**
 * The return to the company lot. Carries only a position — there is no photo:
 * the vehicle being back in the yard is something the fleet can see, and asking
 * for a picture of a parking space at the end of a shift is friction with no
 * evidential value.
 */
export const fleetReturnSchema = z.object({
  latitude:   z.number().min(-90).max(90).optional(),
  longitude:  z.number().min(-180).max(180).optional(),
  accuracy_m: z.number().min(0).optional(),
})

/**
 * A proof photo supplied after the stop was already confirmed. Just the URL —
 * no position, deliberately: this photo is not evidence of WHERE the driver was
 * (that was recorded at the stop and must not be rewritten), only of what came
 * off the truck.
 */
export const attachStopProofSchema = z.object({
  proof_photo_url: z.string().url('A proof photo is required'),
})

/**
 * Operations pauses the delivery. The note is required: the driver and the rest
 * of the office need to know why.
 */
export const staffPauseTripSchema = z.object({
  reason: z.enum(PAUSE_REASONS),
  note:   z.string().trim().min(3, 'Say why the delivery is paused').max(500),
})

/** Operations sets when a paused delivery continues: a date and the driver's call time. */
export const pauseContinuationSchema = z.object({
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  call_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Pick a call time'),
}).strict()

/** Operations ends the pause from the web, optionally saying why. */
export const staffResumeTripSchema = z.object({
  note: z.string().trim().max(500).optional().nullable(),
})

/** Start Navigation: the booking goes in transit. `early_start` is the driver's
 *  deliberate "start before the scheduled day", as on a pickup. */
export const startDeliverySchema = z.object({
  early_start: z.boolean().optional(),
}).strict()

/** The new driver moved the load across after a crew replacement. Photo +
 *  position, exactly like a stop confirmation. */
export const loadTransferSchema = driverStopProofSchema

const MILESTONE_STAGE = z.enum(['arrived_parking', 'docked', 'started', 'departed'])

/** A driver's tap at a stop. The trip (and drop-off) by id, or by number +
 *  drop-off for ones the phone created offline. `at` is the phone's
 *  server-corrected time, used only when the tap was queued. */
export const recordMilestoneSchema = z.object({
  stage:          MILESTONE_STAGE,
  trip_id:        z.string().uuid().optional().nullable(),
  trip_number:    z.number().int().min(1).optional().nullable(),
  trip_stop_id:   z.string().uuid().optional().nullable(),
  destination_id: z.string().uuid().optional().nullable(),
  at:             z.string().datetime().optional().nullable(),
  latitude:       z.number().min(-90).max(90).optional().nullable(),
  longitude:      z.number().min(-180).max(180).optional().nullable(),
  accuracy_m:     z.number().min(0).optional().nullable(),
}).refine((b) => !!b.trip_id || !!b.trip_number, { message: 'trip_id or trip_number is required' })

/** The office fills in or corrects one stop time. */
export const staffSetMilestoneSchema = z.object({
  trip_id:      z.string().uuid(),
  trip_stop_id: z.string().uuid().optional().nullable(),
  stage:        MILESTONE_STAGE,
  at:           z.string().datetime({ offset: true }),
  note:         z.string().trim().min(3, 'Say why the time is being changed').max(500),
}).strict()

/**
 * The driver's call time, set by operations in the Trip Planner. `null` clears
 * it, and the driver follows the client's call time again.
 */
export const driverCallTimeSchema = z.object({
  driver_call_time: z.string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'driver_call_time must be in HH:MM format')
    .nullable(),
})
