import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as VendorService from '../../services/admin/vendor.service.js'

export async function getAllVendors(req: Request, res: Response) {
  try {
    const data = await VendorService.getAllVendors()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getVendorById(req: Request, res: Response) {
  try {
    const data = await VendorService.getVendorById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Vendor not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createVendor(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await VendorService.createVendor(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateVendor(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await VendorService.updateVendor(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteVendor(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await VendorService.deleteVendor(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Vendor deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deactivateVendor(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await VendorService.deactivateVendor(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Vendor deactivated', data })
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function activateVendor(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await VendorService.activateVendor(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Vendor activated', data })
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}