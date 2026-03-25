import { TruckModelModel } from '../../models/admin/truck-models.model.js'
import { CreateTruckModelInput, UpdateTruckModelInput } from '../../types/truck-model.types.js'

export async function getAllTruckModels() {
  return TruckModelModel.findAll()
}

export async function getTruckModelById(modelId: string) {
  const model = await TruckModelModel.findById(modelId)
  if (!model) throw new Error('Truck model not found')
  return model
}

export async function createTruckModel(input: CreateTruckModelInput) {
  return TruckModelModel.create(input)
}

export async function updateTruckModel(modelId: string, input: UpdateTruckModelInput) {
  const existing = await TruckModelModel.findById(modelId)
  if (!existing) throw new Error('Truck model not found')
  return TruckModelModel.update(modelId, input)
}

export async function deleteTruckModel(modelId: string) {
  const existing = await TruckModelModel.findById(modelId)
  if (!existing) throw new Error('Truck model not found')
  return TruckModelModel.remove(modelId)
}