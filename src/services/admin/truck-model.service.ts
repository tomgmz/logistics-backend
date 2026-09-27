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

export async function createTruckModel(input: CreateTruckModelInput, actorId?: string | null) {
  const result = await TruckModelModel.create(input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_model_created',
    description: `Vehicle model ${input.name} created`,

  })

  return result
}

export async function updateTruckModel(modelId: string, input: UpdateTruckModelInput, actorId?: string | null) {
  const existing = await TruckModelModel.findById(modelId)
  if (!existing) throw new Error('Truck model not found')

  const result = await TruckModelModel.update(modelId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_model_updated',
    description: `Vehicle model ${modelId} updated`,

  })

  return result
}

/**
 * Take a model out of the catalog. Refused while any active vehicle is still
 * built on it: the vehicle form could no longer show that truck's model, and
 * the model is plainly not retired while trucks of it are on the road.
 */
export async function archiveTruckModel(modelId: string, actorId?: string | null) {
  const existing = await TruckModelModel.findById(modelId)
  if (!existing) throw new Error('Truck model not found')

  const plates = await TruckModelModel.activeTruckPlates(modelId)
  if (plates.length > 0) {
    const shown = plates.slice(0, 3).join(', ')
    const more  = plates.length > 3 ? ` and ${plates.length - 3} more` : ''
    throw new Error(
      `${existing.name} is still used by ${shown}${more} — move or archive ${plates.length === 1 ? 'that vehicle' : 'those vehicles'} first`,
    )
  }

  const result = await TruckModelModel.archive(modelId)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_model_archived',
    description: `Vehicle model ${existing.name} archived`,
  })

  return result
}
