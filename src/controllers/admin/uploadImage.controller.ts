import { Request, Response } from 'express'
import { putFile, extForMime } from '../../lib/storage.js'
import { proofPhotoBytes, ProofNotOnCrewError } from '../../services/driver/proof-stamp.service.js'

export async function uploadImage(req: Request, res: Response) {
  try {
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'No image file provided' })
      return
    }

    const result = await putFile(req.file!.buffer, { folder: 'truck_models', ext: extForMime(req.file!.mimetype) })

    res.status(200).json({ status: 'success', data: { url: result.ref } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

/**
 * Proof of pickup / proof of delivery photo, taken by the driver at a stop.
 * Returns the hosted URL, which the driver app then sends with the stop
 * confirmation (PATCH /driver/bookings/:id/pickup | .../delivered).
 *
 * Optional multipart fields (stamp_stop, stamp_ref, taken_at, latitude,
 * longitude, accuracy_m, added_later) ask for the time-and-place stamp — see
 * services/driver/proof-stamp.service.ts.
 */
export async function uploadDeliveryProof(req: Request, res: Response) {
  try {
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'No image file provided' })
      return
    }

    // Burns in the time / place / plate stamp when the app sent the stop it
    // belongs to; anything else is stored as it came.
    const { buffer, stamped } = await proofPhotoBytes(
      req.file.buffer,
      req.body,
      { userId: req.user?.sub, role: req.user?.role },
    )

    const result = await putFile(buffer, {
      folder: stamped ? 'delivery_proofs/stamped' : 'delivery_proofs',
      ext:    stamped ? 'jpg' : extForMime(req.file.mimetype),
    })

    res.status(200).json({ status: 'success', data: { url: result.ref } })
  } catch (err: any) {
    res.status(err instanceof ProofNotOnCrewError ? 403 : 500).json({ status: 'error', message: err.message })
  }
}

export async function uploadDriverLicense(req: Request, res: Response) {
  try {
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'No image file provided' })
      return
    }

    const result = await putFile(req.file!.buffer, { folder: 'driver_licenses', ext: extForMime(req.file!.mimetype) })

    res.status(200).json({ status: 'success', data: { url: result.ref } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

/**
 * Photo of a vehicle's dashboard odometer or a service receipt, taken by the
 * Fleet Manager. Returns the hosted URL, sent with the reading/service after.
 */
export async function uploadFleetRecordPhoto(req: Request, res: Response) {
  try {
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'No image file provided' })
      return
    }

    const result = await putFile(req.file!.buffer, { folder: 'fleet_records', ext: extForMime(req.file!.mimetype) })

    res.status(200).json({ status: 'success', data: { url: result.ref } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
