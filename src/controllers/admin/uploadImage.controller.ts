import { Request, Response } from 'express'
import { cloudinary } from '../../lib/cloudinary.js'

export async function uploadImage(req: Request, res: Response) {
  try {
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'No image file provided' })
      return
    }

    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'truck_models', resource_type: 'image' },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error('Upload failed'))
          resolve(result)
        }
      )
      stream.end(req.file!.buffer)
    })

    res.status(200).json({ status: 'success', data: { url: result.secure_url } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

/**
 * Proof of pickup / proof of delivery photo, taken by the driver at a stop.
 * Returns the hosted URL, which the driver app then sends with the stop
 * confirmation (PATCH /driver/bookings/:id/pickup | .../delivered).
 */
export async function uploadDeliveryProof(req: Request, res: Response) {
  try {
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'No image file provided' })
      return
    }

    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder:        'delivery_proofs',
          resource_type: 'image',
          tags:          ['delivery_proof'],
        },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error('Upload failed'))
          resolve(result)
        }
      )
      stream.end(req.file!.buffer)
    })

    res.status(200).json({ status: 'success', data: { url: result.secure_url } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function uploadDriverLicense(req: Request, res: Response) {
  try {
    if (!req.file) {
      res.status(400).json({ status: 'error', message: 'No image file provided' })
      return
    }

    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder:        'driver_licenses',
          resource_type: 'image',
          tags:          ['driver_license'],
        },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error('Upload failed'))
          resolve(result)
        }
      )
      stream.end(req.file!.buffer)
    })

    res.status(200).json({ status: 'success', data: { url: result.secure_url } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}