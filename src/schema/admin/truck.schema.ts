import { z } from 'zod'

// PH plate: ABC 1234, ABC 123 or AB 123. Shared with the vendor vehicle on an
// assignment (assignment.schema.ts) and mirrored by the web lib/validation/plate.ts.
export const PLATE_REGEX = /^(?:[A-ZÑ]{3} ?\d{4}|[A-ZÑ]{2,3} ?\d{2,3})$/
export const PLATE_ERROR = 'Invalid PH plate format (e.g. ABC 1234). Only letters, and numbers are allowed.'

const km       = z.number().int('Whole kilometres only').min(0).max(5_000_000)
const day      = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
const photoUrl = z.string().url()

// Routine service schedule — every N km or N months, whichever comes first.
const schedule = {
  service_interval_km:      z.number().int().min(100, 'At least 100 km').max(200_000),
  service_interval_months:  z.number().int().min(1).max(60),
  last_service_at:          day,
  last_service_odometer_km: km,
}

export const createTruckSchema = z.object({
  plate_number: z
    .string()
    .toUpperCase()
    .regex(
      PLATE_REGEX,
      'Invalid PH plate format (e.g. ABC 1234). Only letters, and numbers are allowed.',
    ),
  model_id:  z.string().uuid().optional().nullable(),
  // Required at creation: there is no system default, every vehicle gets its own.
  odometer_km:        km,
  odometer_photo_url: photoUrl.optional().nullable(),
  ...schedule,
  // Last day the LTO registration is valid. Required for every new vehicle; an
  // expired one cannot be assigned (fleet-availability assertRegistrationValid).
  registration_expiry: day,
  // Optional regular driver, so a vehicle can be paired as it is created
  // instead of needing a second trip through Update Details.
  assigned_driver_id: z.string().uuid().optional().nullable(),
})

export const updateTruckSchema = z.object({
  service_interval_km:      schedule.service_interval_km.optional(),
  service_interval_months:  schedule.service_interval_months.optional(),
  // Baseline + first reading: only for a vehicle that predates the schedule;
  // the service enforces that.
  last_service_at:          day.optional(),
  last_service_odometer_km: km.optional(),
  odometer_km:              km.optional(),
  // Changed when the registration is renewed; a new date re-arms the reminder.
  registration_expiry:      day.optional(),
  plate_number: z
    .string()
    .toUpperCase()
    .regex(
      PLATE_REGEX,
      'Invalid PH plate format (e.g. ABC 1234). Only letters, and numbers are allowed.',
    )
    .optional(),
  model_id:  z.string().uuid().optional().nullable(),
  // No 'archived': that goes through POST /trucks/:id/archive, which also
  // releases the driver pairing and refuses a vehicle that is out on a booking.
  status:    z.enum(['available', 'recheck_due', 'in_use', 'under_maintenance', 'inactive']).optional(),
  // The vehicle's regular driver. Explicitly nullable: sending null is how the
  // fleet manager unpairs a truck.
  assigned_driver_id: z.string().uuid().optional().nullable(),
})

// The fleet manager's BLOWBAGETS inspection of a vehicle. Every item must be
// reported (true = passed); the service derives the overall pass/fail from them.
export const recordTruckInspectionSchema = z.object({
  items: z.object({
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
  }),
  notes: z.string().max(500).optional().nullable(),
})

/**
 * An odometer reading off the dash, with its photo. The after-delivery reading
 * when the vehicle is back from a job, otherwise an ad-hoc update.
 */
export const recordOdometerSchema = z.object({
  reading_km: km,
  photo_url:  photoUrl,
})

/** A routine service; restarts the schedule from its date and odometer. */
export const recordServiceSchema = z.object({
  serviced_at: day,
  odometer_km: km,
  work_done:   z.string().trim().min(1, 'Describe the work done').max(2000),
  workshop:    z.string().trim().max(200).optional().nullable(),
  receipt_url: photoUrl.optional().nullable(),
})