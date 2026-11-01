import { Request, Response }  from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as DriverService        from '../../services/admin/driver.service.js'
import { LicenseCheckError, licenseHistory } from '../../services/admin/driver-license.service.js'
import { extractLicenseData, type LicenseOCRResult } from '../../services/admin/driver-ocr.service.js'
import { putFile, extForMime }   from '../../lib/storage.js'

async function uploadLicense(file: Express.Multer.File): Promise<string> {
  const { ref } = await putFile(file.buffer, { folder: 'driver_licenses', ext: extForMime(file.mimetype) })
  return ref
}

export async function getAllDrivers(req: Request, res: Response) {
  try {
    const data = await DriverService.getAllDrivers()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

/**
 * The assignable pool for one day: `GET /admin/drivers/assignable?date=YYYY-MM-DD`.
 *
 * The date is required rather than defaulting to today, because a silent default
 * would quietly answer a different question than the caller asked and hand back
 * a plausible-looking list for the wrong day.
 */
export async function getAssignableDrivers(req: Request, res: Response) {
  try {
    const date = String(req.query.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ status: 'error', message: 'A date (YYYY-MM-DD) is required' })
      return
    }
    // Comma-separated: the main and second driver already on the booking.
    const current = String(req.query.current_driver_id ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const data    = await DriverService.getAssignableDrivers(date, current)
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
    const { userId } = getRequestMeta(req)
    const { license_verified, license_change_note, ...fields } = req.body ?? {}
    // Read on the server too, so the checks don't rest on the browser's scan.
    let scanned: LicenseOCRResult | null = null
    let scanFailed = false
    try { scanned = await extractLicenseData(req.file.buffer) } catch { scanFailed = true }
    const license_image_url = await uploadLicense(req.file)
    const data = await DriverService.createDriver(
      { ...fields, license_image_url },
      userId,
      { scanned, scanFailed, verified: license_verified === true, note: license_change_note ?? null },
    )
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    if (error instanceof LicenseCheckError) {
      res.status(error.status).json({ status: 'error', message: error.message, code: error.code, issues: error.issues })
      return
    }
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateDriver(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const { license_verified, license_change_note, ...fields } = req.body ?? {}
    // A replacement license photo arrives as multipart; plain JSON edits have no
    // file. It is read here too, so the checks don't rest on the browser's scan.
    let scanned: LicenseOCRResult | null = null
    let scanFailed = false
    if (req.file) {
      try { scanned = await extractLicenseData(req.file.buffer) } catch { scanFailed = true }
    }
    const body = req.file
      ? { ...fields, license_image_url: await uploadLicense(req.file) }
      : fields
    const data = await DriverService.updateDriver(param(req.params.id), body, userId, {
      scanned, scanFailed, verified: license_verified === true, note: license_change_note ?? null,
    })
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    if (error instanceof LicenseCheckError) {
      res.status(error.status).json({ status: 'error', message: error.message, code: error.code, issues: error.issues })
      return
    }
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteDriver(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await DriverService.deleteDriver(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Driver archived successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deactivateDriver(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await DriverService.deactivateDriver(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Driver deactivated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function standDownDriver(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await DriverService.standDownDriver(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Driver returned to the available pool', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      // Refusing to release a driver who is genuinely out on a delivery, and
      // refusing one who was never reserved, are both conflicts with the state
      // the caller is looking at — not server faults.
      : error.message.includes('active delivery') || error.message.includes('not reserved') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function activateDriver(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await DriverService.activateDriver(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'Driver activated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}
/** The licenses a driver held before this one, newest first. */
export async function getLicenseHistory(req: Request, res: Response) {
  try {
    const data = await licenseHistory(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}
