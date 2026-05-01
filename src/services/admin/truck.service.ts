import * as TruckModel from '../../models/admin/truck.model.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllTrucks() {
  return TruckModel.findAll()
}

export async function getTruckById(truckId: string) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')
  return truck
}

export async function createTruck(input: CreateTruckInput, actorId?: string | null, ip?: string | null) {
  const result = await TruckModel.create(input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_created',
    description: `Vehicle ${input.plate_number} created`,
    ip_address:  ip,
  })

  return result
}

export async function updateTruck(truckId: string, input: UpdateTruckInput, actorId?: string | null, ip?: string | null) {
  const result = await TruckModel.update(truckId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_updated',
    description: `Vehicle ${truckId} updated`,
    ip_address:  ip,
  })

  return result
}

export async function deleteTruck(truckId: string, actorId?: string | null, ip?: string | null) {
  const result = await TruckModel.remove(truckId)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_deleted',
    description: `Vehicle ${truckId} deleted`,
    ip_address:  ip,
  })

  return result
}