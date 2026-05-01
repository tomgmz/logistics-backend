import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as TruckService from '../../services/admin/truck.service.js'

export async function getAllTrucks(req: Request, res: Response) {
  try {
    const data = await TruckService.getAllTrucks()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getTruckById(req: Request, res: Response) {
  try {
    const data = await TruckService.getTruckById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Truck not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createTruck(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await TruckService.createTruck(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateTruck(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await TruckService.updateTruck(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteTruck(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await TruckService.deleteTruck(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Truck deleted successfully' })
  } catch (err: any) {
    const status = err.message.includes('No truck found') ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}