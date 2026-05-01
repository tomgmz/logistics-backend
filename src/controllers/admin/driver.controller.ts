import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as DriverService from '../../services/admin/driver.service.js'

export async function getAllDrivers(req: Request, res: Response) {
  try {
    const data = await DriverService.getAllDrivers()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getDriverById(req: Request, res: Response) {
  try {
    const data = await DriverService.getDriverById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Driver not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createDriver(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await DriverService.createDriver(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateDriver(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await DriverService.updateDriver(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteDriver(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await DriverService.deleteDriver(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Driver deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}