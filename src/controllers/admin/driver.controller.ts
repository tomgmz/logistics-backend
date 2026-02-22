import { Request, Response } from 'express'
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
    const data = await DriverService.getDriverById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Driver not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createDriver(req: Request, res: Response) {
  try {
    const data = await DriverService.createDriver(req.body)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateDriver(req: Request, res: Response) {
  try {
    const data = await DriverService.updateDriver(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteDriver(req: Request, res: Response) {
  try {
    await DriverService.deleteDriver(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Driver deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}