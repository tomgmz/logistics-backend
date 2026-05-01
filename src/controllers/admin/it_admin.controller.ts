import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as ITAdminService from '../../services/admin/it_admin.service.js'

export async function getAllITAdmins(req: Request, res: Response) {
  try {
    const data = await ITAdminService.getAllITAdmins()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getITAdminById(req: Request, res: Response) {
  try {
    const data = await ITAdminService.getITAdminById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'IT Admin not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createITAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await ITAdminService.createITAdmin(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateITAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await ITAdminService.updateITAdmin(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteITAdmin(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await ITAdminService.deleteITAdmin(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'IT Admin deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}