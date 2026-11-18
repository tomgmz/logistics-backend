import { TruckModelModel } from '../../models/admin/truck-models.model.js'
import { CreateTruckModelInput, UpdateTruckModelInput } from '../../types/truck-model.types.js'
import { logEvent } from '../../lib/log-event.js'
import { conflict, notFound } from '../../lib/http-error.js'
import { resolveModelVehicleType } from './vehicle-type.service.js'

export async function getAllTruckModels(archivedOnly = false) {
  return TruckModelModel.findAll(archivedOnly)
}

export async function getTruckModelById(modelId: string) {
  const model = await TruckModelModel.findById(modelId)
  if (!model) throw new Error('Truck model not found')
  return model
}

export async function createTruckModel(input: CreateTruckModelInput, actorId?: string | null) {
  const vehicle_type = await resolveModelVehicleType(input.vehicle_type)
  const result = await TruckModelModel.create({ ...input, vehicle_type })

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

  if (input.vehicle_type !== undefined) {
    input = { ...input, vehicle_type: await resolveModelVehicleType(input.vehicle_type, existing.vehicle_type) }
  }
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

/**
 * Undo an archive (user 2026-11-18): the model is back in the catalog and can
 * be picked for new vehicles again. Refused when a current model already has
 * the same name.
 */
export async function restoreTruckModel(modelId: string, actorId?: string | null) {
  const existing = await TruckModelModel.findById(modelId)
  if (!existing) throw notFound('Truck model not found')
  if (!existing.archived_at) throw conflict(`${existing.name} is not archived (it may have been restored already).`)

  if (await TruckModelModel.activeWithName(existing.name, modelId)) {
    throw conflict(`A model named ${existing.name} is already in the catalog, so this one can't be restored.`)
  }
  if (!(await TruckModelModel.restore(modelId))) throw conflict(`${existing.name} was restored a moment ago.`)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_model_restored',
    description: `Vehicle model ${existing.name} restored from the archive`,
  })
}
