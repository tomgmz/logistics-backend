import { Request, Response }  from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as DriverService        from '../../services/admin/driver.service.js'
import { cloudinary }            from '../../lib/cloudinary.js'

function uploadToCloudinary(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'driver_licenses', resource_type: 'image', tags: ['driver_license'] },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'))
        resolve(result.secure_url)
      },
    )
    stream.end(buffer)
  })
}

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
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'License image is required' })
      return
    }
    const { userId, ip }    = getRequestMeta(req)
    const license_image_url = await uploadToCloudinary(req.file.buffer)
    const data              = await DriverService.createDriver(
      { ...req.body, license_image_url },
      userId,
      ip,
    )
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

export async function deactivateDriver(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await DriverService.deactivateDriver(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Driver deactivated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function activateDriver(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await DriverService.activateDriver(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Driver activated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}