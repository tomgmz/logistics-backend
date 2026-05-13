import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as GeneralManagerService from '../../services/admin/general_manager.service.js'

export async function getAllGeneralManagers(req: Request, res: Response) {
  try {
    const data = await GeneralManagerService.getAllGeneralManagers()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getGeneralManagerById(req: Request, res: Response) {
  try {
    const data = await GeneralManagerService.getGeneralManagerById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'General Manager not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createGeneralManager(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await GeneralManagerService.createGeneralManager(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateGeneralManager(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await GeneralManagerService.updateGeneralManager(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteGeneralManager(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await GeneralManagerService.deleteGeneralManager(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'General Manager deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deactivateGeneralManager(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await GeneralManagerService.deactivateGeneralManager(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'General Manager deactivated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function activateGeneralManager(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await GeneralManagerService.activateGeneralManager(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'General Manager activated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}