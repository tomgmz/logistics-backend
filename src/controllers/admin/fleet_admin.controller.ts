import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as FleetAdminService from '../../services/admin/fleet_admin.service.js'

export async function getAllFleetAdmins(req: Request, res: Response) {
  try {
    const data = await FleetAdminService.getAllFleetAdmins()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getFleetAdminById(req: Request, res: Response) {
  try {
    const data = await FleetAdminService.getFleetAdminById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Fleet Manager not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createFleetAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await FleetAdminService.createFleetAdmin(req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateFleetAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await FleetAdminService.updateFleetAdmin(param(req.params.id), req.body, userId)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteFleetAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await FleetAdminService.deleteFleetAdmin(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Fleet Manager deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deactivateFleetAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await FleetAdminService.deactivateFleetAdmin(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Fleet Manager deactivated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function activateFleetAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await FleetAdminService.activateFleetAdmin(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Fleet Manager activated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}