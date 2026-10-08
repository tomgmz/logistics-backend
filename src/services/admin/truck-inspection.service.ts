import * as InspectionModel from '../../models/admin/truck-inspection.model.js'
import * as TruckModel from '../../models/admin/truck.model.js'
import { logEvent } from '../../lib/log-event.js'
import type { BlowbagetsItems } from '../../types/client/booking.types.js'
import * as UpkeepModel from '../../models/admin/truck-upkeep.model.js'
import { assertReadingPlausible, assertReturnOdometerRecorded } from './truck-upkeep.service.js'
import { liveBookingForTruck } from '../../lib/driver-reservation.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from '../notification/notification.service.js'

// The ten items of the BLOWBAGETS mnemonic. Battery and Brakes both start with
// B, so the keys — not the letters — are the stable identifiers.
export const BLOWBAGETS_KEYS: (keyof BlowbagetsItems)[] = [
  'battery', 'lights', 'oil', 'water', 'brakes', 'air', 'gas', 'engine', 'tires', 'self',
]

export interface RecordInspectionInput {
  items:  BlowbagetsItems
  notes?: string | null
  /** The before-delivery odometer, with a photo of the dash. */
  odometer_km:        number
  odometer_photo_url: string
}

/**
 * Record a fleet manager's inspection of a vehicle. The inspection passes only
 * when every item is ticked; a single fault fails it, and a failed vehicle drops
 * out of the operations selection list until it passes a re-check.
 */
export async function recordInspection(
  truckId: string,
  input: RecordInspectionInput,
  actorId?: string | null,
) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')

  // A vehicle back from a delivery owes its after-delivery reading first, so
  // every job is metered at both ends.
  await assertReturnOdometerRecorded(truck)
  assertReadingPlausible(truck, input.odometer_km)

  const items  = Object.fromEntries(
    BLOWBAGETS_KEYS.map((key) => [key, input.items[key] === true]),
  ) as unknown as BlowbagetsItems
  const passed = BLOWBAGETS_KEYS.every((key) => items[key])

  const inspection = await InspectionModel.create({
    truck_id:     truckId,
    items,
    passed,
    notes:        input.notes ?? null,
    inspected_by: actorId ?? null,
  })

  await UpkeepModel.insertReading({
    truck_id:      truckId,
    reading_km:    input.odometer_km,
    kind:          'pre_trip',
    photo_url:     input.odometer_photo_url,
    inspection_id: inspection.inspection_id,
    recorded_by:   actorId ?? null,
  })

  // A failed inspection also takes the vehicle out of service so it can't be
  // picked through any other path; a pass returns it to the pool unless it is
  // currently out on a delivery. 'recheck_due' is the hold a vehicle is put on
  // when it comes back from a job, and this pass is the re-check that lifts it.
  //
  // Either way the vehicle may already be on a booking. A fail then pulls it off
  // the road like a manual Under Maintenance would, so Operations is told; a pass
  // puts it back to 'in_use', since it is still committed to that booking.
  const onBooking = !passed || truck.status === 'under_maintenance' || truck.status === 'recheck_due'
    ? await liveBookingForTruck(truckId)
    : null
  if (!passed && truck.status !== 'archived') {
    await TruckModel.update(truckId, { status: 'under_maintenance' })
    if (onBooking && truck.status !== 'under_maintenance') {
      void BookingModel.findById(onBooking.booking_id).then((full) => full && notifyStage('vehicle_out_of_service', full, {
        vehicleLabel: truck.plate_number,
        statusLabel:  'Under Maintenance after a failed BLOWBAGETS inspection',
        onTheRoad:    onBooking.status !== 'assigned',
      })).catch((err) => console.error('[inspection] failed to notify out-of-service vehicle', truckId, err))
    }
  } else if (passed && (truck.status === 'under_maintenance' || truck.status === 'recheck_due')) {
    await TruckModel.update(truckId, { status: onBooking ? 'in_use' : 'available' })
  }

  const failed = BLOWBAGETS_KEYS.filter((key) => !items[key])
  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      passed ? 'vehicle_inspection_passed' : 'vehicle_inspection_failed',
    description: passed
      ? `BLOWBAGETS inspection passed for vehicle ${truck.plate_number}`
      : `BLOWBAGETS inspection failed for vehicle ${truck.plate_number} (${failed.join(', ')})`,
  })

  return inspection
}

export function getInspectionHistory(truckId: string) {
  return InspectionModel.listForTruck(truckId)
}
