import { Request, Response } from 'express'
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
    const data = await TruckModelService.getTruckModelById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Truck model not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createTruckModel(req: Request, res: Response) {
  try {
    const data = await TruckModelService.createTruckModel(req.body)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateTruckModel(req: Request, res: Response) {
  try {
    const data = await TruckModelService.updateTruckModel(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Truck model not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function deleteTruckModel(req: Request, res: Response) {
  try {
    await TruckModelService.deleteTruckModel(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Truck model deleted successfully' })
  } catch (err: any) {
    const status = err.message === 'Truck model not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}