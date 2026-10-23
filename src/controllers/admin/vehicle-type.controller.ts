import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { statusOf } from '../../lib/http-error.js'
import * as VehicleTypeService from '../../services/admin/vehicle-type.service.js'

// ?active=true is what the pickers ask for; System Maintenance reads them all.
export async function getAllVehicleTypes(req: Request, res: Response) {
  try {
    const data = await VehicleTypeService.getAllVehicleTypes(req.query.active === 'true')
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error)).json({ status: 'error', message: error.message })
  }
}

export async function getVehicleTypeById(req: Request, res: Response) {
  try {
    const data = await VehicleTypeService.getVehicleTypeById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error)).json({ status: 'error', message: error.message })
  }
}

export async function createVehicleType(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await VehicleTypeService.createVehicleType(req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error)).json({ status: 'error', message: error.message })
  }
}

export async function updateVehicleType(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await VehicleTypeService.updateVehicleType(param(req.params.id), req.body, userId)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error)).json({ status: 'error', message: error.message })
  }
}

export async function deleteVehicleType(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await VehicleTypeService.deleteVehicleType(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Vehicle type deleted' })
  } catch (error: any) {
    res.status(statusOf(error)).json({ status: 'error', message: error.message })
  }
}
