import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as OperationsAdminService from '../../services/admin/operations_admin.service.js'

export async function getAllOperationsAdmins(req: Request, res: Response) {
  try {
    const data = await OperationsAdminService.getAllOperationsAdmins()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getOperationsAdminById(req: Request, res: Response) {
  try {
    const data = await OperationsAdminService.getOperationsAdminById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Operations Admin not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createOperationsAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await OperationsAdminService.createOperationsAdmin(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateOperationsAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await OperationsAdminService.updateOperationsAdmin(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteOperationsAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await OperationsAdminService.deleteOperationsAdmin(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Operations Admin deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}