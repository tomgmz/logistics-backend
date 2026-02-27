import * as TruckModel from '../../models/admin/truck.model.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'

export async function getAllTrucks() {
  return TruckModel.findAll()
}

export async function getTruckById(truckId: string) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')
  return truck
}

export async function createTruck(input: CreateTruckInput) {
  return TruckModel.create(input)
}

export async function updateTruck(truckId: string, input: UpdateTruckInput) {
  return TruckModel.update(truckId, input)
}

export async function deleteTruck(truckId: string) {
  return TruckModel.remove(truckId)
}