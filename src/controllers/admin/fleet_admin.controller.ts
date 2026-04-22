import { Request, Response } from 'express'
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
    const data = await FleetAdminService.getFleetAdminById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Fleet Admin not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createFleetAdmin(req: Request, res: Response) {
  try {
    const data = await FleetAdminService.createFleetAdmin(req.body)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateFleetAdmin(req: Request, res: Response) {
  try {
    const data = await FleetAdminService.updateFleetAdmin(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteFleetAdmin(req: Request, res: Response) {
  try {
    await FleetAdminService.deleteFleetAdmin(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Fleet Admin deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}