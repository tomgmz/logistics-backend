import { TruckModelModel } from '../../models/admin/truck-models.model.js'
import { CreateTruckModelInput, UpdateTruckModelInput } from '../../types/truck-model.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllTruckModels() {
  return TruckModelModel.findAll()
}

export async function getTruckModelById(modelId: string) {
  const model = await TruckModelModel.findById(modelId)
  if (!model) throw new Error('Truck model not found')
  return model
}

export async function createTruckModel(input: CreateTruckModelInput, actorId?: string | null, ip?: string | null) {
  const result = await TruckModelModel.create(input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_model_created',
    description: `Vehicle model ${input.name} created`,
    ip_address:  ip,
  })

  return result
}

export async function updateTruckModel(modelId: string, input: UpdateTruckModelInput, actorId?: string | null, ip?: string | null) {
  const existing = await TruckModelModel.findById(modelId)
  if (!existing) throw new Error('Truck model not found')

  const result = await TruckModelModel.update(modelId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_model_updated',
    description: `Vehicle model ${modelId} updated`,
    ip_address:  ip,
  })

  return result
}

export async function deleteTruckModel(modelId: string, actorId?: string | null, ip?: string | null) {
  const existing = await TruckModelModel.findById(modelId)
  if (!existing) throw new Error('Truck model not found')

  const result = await TruckModelModel.remove(modelId)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_model_deleted',
    description: `Vehicle model ${modelId} deleted`,
    ip_address:  ip,
  })

  return result
}