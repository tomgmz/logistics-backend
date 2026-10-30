import * as TruckModel from '../../models/admin/truck.model.js'
import * as UpkeepModel from '../../models/admin/truck-upkeep.model.js'
import { lastFleetReturnFor } from '../../lib/driver-reservation.js'
import { serviceStatus, type ServiceScheduleFields } from '../../lib/service-schedule.js'
import { asDay, phDay } from '../../lib/ph-date.js'
import { logEvent } from '../../lib/log-event.js'

/**
 * Odometer and routine-service upkeep for a vehicle.
 *
 * The odometer is kept apart from the BLOWBAGETS inspection. The Fleet Manager
 * or Company Administrator types it, with a photo of the dash:
 *   at creation — the vehicle's first reading
 *   on return   — once the driver has stamped the vehicle back in the lot. The
 *                 vehicle can't be assigned again until this reading exists, so
 *                 a job can't go unmetered.
 *   any time    — e.g. a multi-trip run paused for weather and the vehicle
 *                 came back to the parking lot in between.
 */

/** The schedule fields of a truck row, with the `date` column as `YYYY-MM-DD`. */
export function scheduleOf(truck: any): ServiceScheduleFields {
  return {
    service_interval_km:      truck.service_interval_km ?? null,
    service_interval_months:  truck.service_interval_months ?? null,
    last_service_at:          asDay(truck.last_service_at),
    last_service_odometer_km: truck.last_service_odometer_km ?? null,
    odometer_km:              truck.odometer_km ?? null,
  }
}

/**
 * Throws unless `km` can be the vehicle's next reading. Odometers only go up; a
 * lower number is a typo (or a swapped dash), and accepting it would wind the
 * service counter back. A return reading must be strictly higher: the vehicle
 * has just done a delivery, so the same number means the old reading was retyped.
 */
export function assertReadingPlausible(
  truck: { odometer_km?: number | null; plate_number: string },
  km: number,
  opts: { isReturn?: boolean } = {},
): void {
  if (!Number.isInteger(km) || km < 0) throw new Error('Enter the odometer in whole kilometres')
  if (truck.odometer_km != null && km < truck.odometer_km) {
    throw new Error(
      `The odometer can't go down — ${truck.plate_number} was last recorded at ` +
      `${truck.odometer_km.toLocaleString()} km`,
    )
  }
  if (opts.isReturn && truck.odometer_km != null && km === truck.odometer_km) {
    throw new Error(
      `${truck.plate_number} is back from a delivery — the return odometer must be higher than ` +
      `the last reading (${truck.odometer_km.toLocaleString()} km)`,
    )
  }
}

/**
 * True when the vehicle has come back from a booking since its latest reading,
 * i.e. the Fleet Manager still owes the after-delivery odometer.
 */
export function returnOdometerDue(
  truck: { odometer_recorded_at?: string | Date | null },
  lastReturnAt: string | null,
): boolean {
  if (!lastReturnAt) return false
  if (!truck.odometer_recorded_at) return true
  const recorded = truck.odometer_recorded_at instanceof Date
    ? truck.odometer_recorded_at.toISOString()
    : truck.odometer_recorded_at
  return Date.parse(recorded) < Date.parse(lastReturnAt)
}

export async function assertReturnOdometerRecorded(truck: any): Promise<void> {
  const lastReturn = await lastFleetReturnFor(truck.truck_id)
  if (returnOdometerDue(truck, lastReturn)) {
    throw new Error(
      `${truck.plate_number} is back from a delivery — record its return odometer ` +
      'before it can be assigned again',
    )
  }
}

/**
 * Record an odometer reading. When the vehicle is back from a job and still owes
 * its after-delivery reading, this is that reading, linked to the booking.
 * Otherwise it is an ad-hoc update.
 */
export async function recordOdometerReading(
  truckId: string,
  input: { reading_km: number; photo_url: string },
  actorId?: string | null,
) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')
  if (truck.status === 'archived') throw new Error('An archived vehicle cannot have its odometer updated')

  const isReturn = returnOdometerDue(truck, await lastFleetReturnFor(truckId))
  assertReadingPlausible(truck, input.reading_km, { isReturn })

  const reading = await UpkeepModel.insertReading({
    truck_id:    truckId,
    reading_km:  input.reading_km,
    kind:        isReturn ? 'post_trip' : 'manual',
    photo_url:   input.photo_url,
    booking_id:  isReturn ? await UpkeepModel.lastReturnedBookingId(truckId) : null,
    recorded_by: actorId ?? null,
  })

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      isReturn ? 'vehicle_odometer_return' : 'vehicle_odometer_updated',
    description: `${isReturn ? 'Return odometer' : 'Odometer updated'} for ${truck.plate_number}: ` +
      `${input.reading_km.toLocaleString()} km`,
  })

  return reading
}

/** A routine service, which restarts both the km and the month counters. */
export async function recordService(
  truckId: string,
  input: {
    serviced_at:  string
    odometer_km:  number
    work_done:    string
    workshop?:    string | null
    receipt_url?: string | null
  },
  actorId?: string | null,
) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')

  const schedule = scheduleOf(truck)
  if (input.serviced_at > phDay()) throw new Error('The service date cannot be in the future')
  if (schedule.last_service_at && input.serviced_at < schedule.last_service_at) {
    throw new Error(`The service date is before the last recorded service (${schedule.last_service_at})`)
  }
  if (schedule.last_service_odometer_km != null && input.odometer_km < schedule.last_service_odometer_km) {
    throw new Error(
      `The odometer is below the last service reading (${schedule.last_service_odometer_km.toLocaleString()} km)`,
    )
  }
  if (!input.work_done.trim()) throw new Error('Describe the work done')

  const service = await UpkeepModel.insertService(
    { truck_id: truckId, ...input, work_done: input.work_done.trim(), recorded_by: actorId ?? null },
    truck.odometer_km ?? null,
  )

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_serviced',
    description: `Routine service recorded for ${truck.plate_number} on ${input.serviced_at} ` +
      `at ${input.odometer_km.toLocaleString()} km`,
  })

  return service
}

export async function getUpkeepHistory(truckId: string) {
  const [services, readings] = await Promise.all([
    UpkeepModel.listServices(truckId),
    UpkeepModel.listReadings(truckId),
  ])
  return { services, readings }
}

/** Assignment gate: an overdue vehicle stays in the yard until it is serviced. */
export async function assertServiceNotOverdue(truckId: string): Promise<void> {
  const truck = await TruckModel.findById(truckId)
  if (!truck) return
  const status = serviceStatus(scheduleOf(truck))
  if (status.state === 'overdue') {
    throw new Error(
      `${truck.plate_number} is overdue for its routine service` +
      (status.due_date ? ` (due ${status.due_date} or ${status.due_km?.toLocaleString()} km)` : '') +
      ' — record the service before it can be assigned',
    )
  }
}
