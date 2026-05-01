import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as TruckModelService from '../../services/admin/truck-model.service.js'

export async function getAllTruckModels(req: Request, res: Response) {
  try {
    const data = await TruckModelService.getAllTruckModels()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getTruckModelById(req: Request, res: Response) {
  try {
    const data = await TruckModelService.getTruckModelById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Truck model not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createTruckModel(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await TruckModelService.createTruckModel(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateTruckModel(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await TruckModelService.updateTruckModel(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Truck model not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function deleteTruckModel(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await TruckModelService.deleteTruckModel(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Truck model deleted successfully' })
  } catch (err: any) {
    const status = err.message === 'Truck model not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}