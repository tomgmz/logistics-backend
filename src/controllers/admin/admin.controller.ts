import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as AdminService from '../../services/admin/admin.service.js'

export async function getAllAdmins(req: Request, res: Response) {
  try {
    const data = await AdminService.getAllAdmin()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getAdminById(req: Request, res: Response) {
  try {
    const data = await AdminService.getAdminById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Admin not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AdminService.createAdmin(req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AdminService.updateAdmin(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await AdminService.deleteAdmin(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Admin deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deactivateAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AdminService.deactivateAdmin(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Admin deactivated', data })
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function activateAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AdminService.activateAdmin(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Admin activated', data })
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}