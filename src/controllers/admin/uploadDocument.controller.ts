import { Request, Response } from 'express'
import { cloudinary } from '../../lib/cloudinary.js'
import { getRequestMeta } from '../../lib/controller-utils.js'
import { logEvent } from '../../lib/log-event.js'

const FOLDER = 'booking_documents'

async function uploadToCloudinary(file: Express.Multer.File, bookingRef?: string) {
  const folder = bookingRef ? `${FOLDER}/${bookingRef}` : FOLDER

  const ext      = file.originalname.split('.').pop()?.toLowerCase() ?? ''
  const baseName = file.originalname
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 55)

  const safeName = ext ? `${baseName}.${ext}` : baseName

  return new Promise<{
    url:           string
    public_id:     string
    original_name: string
    format:        string
    bytes:         number
  }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type:   'auto',
        public_id:       safeName,
        unique_filename: true,
        overwrite:       false,
        access_mode:     'public',
        format:          ext || undefined,
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'))
        resolve({
          url:           result.secure_url,
          public_id:     result.public_id,
          original_name: file.originalname,
          format:        result.format ?? ext,
          bytes:         result.bytes  ?? 0,
        })
      },
    )

    stream.end(file.buffer)
  })
}

export const uploadBookingDocuments = async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined

    if (!files || files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No files provided' })
    }
    if (files.length > 3) {
      return res.status(400).json({ status: 'error', message: 'Maximum 3 files allowed' })
    }

    const bookingRef = typeof req.body.booking_ref === 'string'
      ? req.body.booking_ref.trim() || undefined
      : undefined

    const results = await Promise.all(
      files.map((f) => uploadToCloudinary(f, bookingRef))
    )
    const urls = results.map((r) => r.url)

    const { userId, ip } = getRequestMeta(req)
    logEvent({
      user_id:     userId,
      log_type:    'booking',
      action:      'booking_documents_uploaded',
      description: `${files.length} document(s) uploaded${bookingRef ? ` for booking ${bookingRef}` : ''}`,
      ip_address:  ip,
    })

    return res.status(200).json({
      status: 'success',
      data:   { urls, files: results },
    })
  } catch (error: any) {
    const isBadRequest = error.message?.match(/Only PDF|DOCX|too large|files allowed/i)
    return res.status(isBadRequest ? 400 : 500).json({
      status:  'error',
      message: error.message ?? 'Upload failed',
    })
  }
}