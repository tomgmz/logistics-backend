import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as TruckService from '../../services/admin/truck.service.js'
import * as InspectionService from '../../services/admin/truck-inspection.service.js'

export async function getAllTrucks(req: Request, res: Response) {
  try {
    const pageRaw  = req.query.page
    const limitRaw = req.query.limit
    const page     = pageRaw != null && pageRaw !== '' ? parseInt(String(pageRaw), 10) : NaN
    const limit    = limitRaw != null && limitRaw !== '' ? parseInt(String(limitRaw), 10) : NaN

    if (Number.isFinite(page) && Number.isFinite(limit) && limit > 0 && page > 0) {
      const status   = typeof req.query.status   === 'string' ? req.query.status   : 'all'
      const search   = typeof req.query.search   === 'string' ? req.query.search   : ''
      const result   = await TruckService.getAllTrucksPaginated({ page, limit, status, search })
      return res.status(200).json({ status: 'success', data: result.data, meta: result.meta })
    }

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

// The fleet manager's BLOWBAGETS inspection of a vehicle. The newest inspection
// decides whether operations can pick this vehicle for a booking.
export async function recordTruckInspection(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await InspectionService.recordInspection(param(req.params.id), req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Truck not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function getTruckInspections(req: Request, res: Response) {
  try {
    const data = await InspectionService.getInspectionHistory(param(req.params.id))
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