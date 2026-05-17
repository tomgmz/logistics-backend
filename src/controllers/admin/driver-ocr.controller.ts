import { Request, Response } from 'express'
import { extractLicenseData } from '../../services/admin/driver-ocr.service.js'

export async function scanDriverLicense(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ status: 'error', message: 'No image uploaded' })
  }

  try {
    const data = await extractLicenseData(req.file.buffer)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message ?? 'OCR extraction failed' })
  }
}