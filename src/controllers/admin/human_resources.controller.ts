import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as HumanResourcesService from '../../services/admin/human_resources.service.js'

export async function getAllHumanResources(req: Request, res: Response) {
  try {
    const data = await HumanResourcesService.getAllHumanResources()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getHumanResourcesById(req: Request, res: Response) {
  try {
    const data = await HumanResourcesService.getHumanResourcesById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Human Resources not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createHumanResources(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await HumanResourcesService.createHumanResources(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateHumanResources(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await HumanResourcesService.updateHumanResources(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteHumanResources(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await HumanResourcesService.deleteHumanResources(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Human Resources staff deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}