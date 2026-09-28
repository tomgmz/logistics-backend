import * as TruckModel from '../../models/admin/truck.model.js'
import * as UpkeepModel from '../../models/admin/truck-upkeep.model.js'
import { lastFleetReturnFor } from '../../lib/driver-reservation.js'
import { serviceStatus, type ServiceScheduleFields } from '../../lib/service-schedule.js'
import { asDay, phDay } from '../../lib/ph-date.js'
import { logEvent } from '../../lib/log-event.js'

/**
 * Odometer and routine-service upkeep for a vehicle.
 *
 * The Fleet Manager types the odometer, with a photo of the dash, before and
 * after every delivery:
 *   before — at the BLOWBAGETS inspection (truck-inspection.service)
 *   after  — once the driver has stamped the vehicle back in the lot
 *            (recordReturnOdometer). The next BLOWBAGETS is refused until
 *            this reading exists, so a job can't go unmetered.
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
 * service counter back.
 */
export function assertReadingPlausible(truck: { odometer_km?: number | null; plate_number: string }, km: number): void {
  if (!Number.isInteger(km) || km < 0) throw new Error('Enter the odometer in whole kilometres')
  if (truck.odometer_km != null && km < truck.odometer_km) {
    throw new Error(
      `The odometer can't go down — ${truck.plate_number} was last recorded at ` +
      `${truck.odometer_km.toLocaleString()} km`,
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
      'before the next BLOWBAGETS inspection',
    )
  }
}

/** The after-delivery reading. */
export async function recordReturnOdometer(
  truckId: string,
  input: { reading_km: number; photo_url: string },
  actorId?: string | null,
) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')

  const lastReturn = await lastFleetReturnFor(truckId)
  if (!returnOdometerDue(truck, lastReturn)) {
    throw new Error(
      `${truck.plate_number} has no delivery waiting for a return reading — ` +
      'the before-delivery reading is taken with the BLOWBAGETS inspection',
    )
  }
  assertReadingPlausible(truck, input.reading_km)

  const reading = await UpkeepModel.insertReading({
    truck_id:    truckId,
    reading_km:  input.reading_km,
    kind:        'post_trip',
    photo_url:   input.photo_url,
    booking_id:  await UpkeepModel.lastReturnedBookingId(truckId),
    recorded_by: actorId ?? null,
  })

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_odometer_return',
    description: `Return odometer for ${truck.plate_number}: ${input.reading_km.toLocaleString()} km`,
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
