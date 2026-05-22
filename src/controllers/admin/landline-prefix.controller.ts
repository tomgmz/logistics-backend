import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as LandlinePrefixService from '../../services/admin/landline-prefix.service.js'

export async function getAllLandlinePrefixes(req: Request, res: Response) {
  try {
    const data = await LandlinePrefixService.getAllLandlinePrefixes()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getLandlinePrefixById(req: Request, res: Response) {
  try {
    const data = await LandlinePrefixService.getLandlinePrefixById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Landline prefix not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createLandlinePrefix(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await LandlinePrefixService.createLandlinePrefix(req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message?.includes('unique') ? 409 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function updateLandlinePrefix(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await LandlinePrefixService.updateLandlinePrefix(param(req.params.id), req.body, userId)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message?.includes('unique') ? 409 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function deleteLandlinePrefix(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await LandlinePrefixService.deleteLandlinePrefix(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Landline prefix deleted successfully' })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}