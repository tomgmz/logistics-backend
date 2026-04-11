import { Request, Response } from 'express'
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
    const data = await VendorService.getVendorById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Vendor not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createVendor(req: Request, res: Response) {
  try {
    const data = await VendorService.createVendor(req.body)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateVendor(req: Request, res: Response) {
  try {
    const data = await VendorService.updateVendor(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteVendor(req: Request, res: Response) {
  try {
    await VendorService.deleteVendor(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Vendor deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}