import { z } from 'zod'
import { driverStopProofSchema } from './booking.schema.js'

/**
 * Validation for the multi-trip driver flow.
 *
 * The stop confirmations reuse `driverStopProofSchema` unchanged: a trip's
 * pickup and a trip's drop-off carry exactly the same evidence as the
 * single-trip ones did — photo, position, and a reason when the driver forced a
 * confirmation the distance gate would have refused.
 */

export const tripStopProofSchema = driverStopProofSchema

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
