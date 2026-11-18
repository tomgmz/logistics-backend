import { Request, Response } from 'express'
import { extractLicenseData } from '../../services/admin/driver-ocr.service.js'

export async function scanDriverLicense(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ status: 'error', message: 'No image uploaded' })
  }

  try {
    // Always a new read: a re-scan must be able to correct the last one.
    const data = await extractLicenseData(req.file.buffer, { fresh: true })
    if (!data.is_license) {
      return res.status(422).json({ status: 'error', code: 'NOT_A_LICENSE', message: data.not_license_reason })
    }
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message ?? 'OCR extraction failed' })
  }
}