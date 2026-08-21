import * as InspectionModel from '../../models/admin/truck-inspection.model.js'
import * as TruckModel from '../../models/admin/truck.model.js'
import { logEvent } from '../../lib/log-event.js'
import type { BlowbagetsItems } from '../../types/client/booking.types.js'

// The ten items of the BLOWBAGETS mnemonic. Battery and Brakes both start with
// B, so the keys — not the letters — are the stable identifiers.
export const BLOWBAGETS_KEYS: (keyof BlowbagetsItems)[] = [
  'battery', 'lights', 'oil', 'water', 'brakes', 'air', 'gas', 'engine', 'tires', 'self',
]

export interface RecordInspectionInput {
  items:  BlowbagetsItems
  notes?: string | null
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

  // A failed inspection also takes the vehicle out of service so it can't be
  // picked through any other path; a pass returns it to the pool unless it is
  // currently out on a delivery.
  if (!passed && truck.status !== 'archived') {
    await TruckModel.update(truckId, { status: 'under_maintenance' })
  } else if (passed && truck.status === 'under_maintenance') {
    await TruckModel.update(truckId, { status: 'available' })
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
