import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as TruckService from '../../services/admin/truck.service.js'
import * as InspectionService from '../../services/admin/truck-inspection.service.js'
import * as UpkeepService from '../../services/admin/truck-upkeep.service.js'

/**
 * Upkeep refusals are the Fleet Manager's to fix (a typo'd odometer, a missing
 * return reading), so they come back as 4xx with the message, not a 500.
 */
function upkeepStatus(message: string): number {
  if (message === 'Truck not found') return 404
  if (/odometer|service|return reading|return odometer|kilometres|cannot be|Describe the work/i.test(message)) return 400
  return 500
}

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

// Vehicle Management → Maintenance: what needs a mechanic, and why.
export async function getMaintenanceQueue(_req: Request, res: Response) {
  try {
    const data = await TruckService.getMaintenanceQueue()
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
    const { userId } = getRequestMeta(req)
    const data = await TruckService.createTruck(req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(upkeepStatus(err.message)).json({ status: 'error', message: err.message })
  }
}

export async function updateTruck(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await TruckService.updateTruck(param(req.params.id), req.body, userId)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = /already the regular driver|is on booking|set automatically/.test(err.message) ? 409 : upkeepStatus(err.message)
    res.status(status).json({ status: 'error', message: err.message })
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
    res.status(upkeepStatus(err.message)).json({ status: 'error', message: err.message })
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

export async function archiveTruck(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await TruckService.archiveTruck(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Vehicle archived' })
  } catch (err: any) {
    const status = err.message.includes('No truck found') ? 404
      : err.message.includes('out on a booking') ? 409
      : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

// The after-delivery odometer (the before-delivery one rides on the inspection).
export async function recordReturnOdometer(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await UpkeepService.recordReturnOdometer(param(req.params.id), req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(upkeepStatus(err.message)).json({ status: 'error', message: err.message })
  }
}

// A routine service — restarts the km and month counters.
export async function recordService(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await UpkeepService.recordService(param(req.params.id), req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(upkeepStatus(err.message)).json({ status: 'error', message: err.message })
  }
}

// Service history + odometer readings for the vehicle details.
export async function getUpkeepHistory(req: Request, res: Response) {
  try {
    const data = await UpkeepService.getUpkeepHistory(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
