import { Request, Response } from 'express'
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
    const data = await OperationsAdminService.getOperationsAdminById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Operations Admin not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createOperationsAdmin(req: Request, res: Response) {
  try {
    const data = await OperationsAdminService.createOperationsAdmin(req.body)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateOperationsAdmin(req: Request, res: Response) {
  try {
    const data = await OperationsAdminService.updateOperationsAdmin(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteOperationsAdmin(req: Request, res: Response) {
  try {
    await OperationsAdminService.deleteOperationsAdmin(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Operations Admin deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}