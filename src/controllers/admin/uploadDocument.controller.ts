import { Request, Response } from 'express'
import { putFile, safeFileName } from '../../lib/storage.js'
import { getRequestMeta } from '../../lib/controller-utils.js'
import { logEvent } from '../../lib/log-event.js'

const FOLDER = 'booking_documents'

async function uploadDocument(file: Express.Multer.File, ref?: string, root: string = FOLDER) {
  const folder   = ref ? `${root}/${ref}` : root
  const fileName = safeFileName(file.originalname)
  const stored   = await putFile(file.buffer, { folder, fileName, contentType: file.mimetype })
  return {
    url:           stored.ref,
    public_id:     stored.key,
    original_name: file.originalname,
    format:        fileName.split('.').pop() ?? '',
    bytes:         stored.bytes,
  }
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
      files.map((f) => uploadDocument(f, bookingRef))
    )
    const urls = results.map((r) => r.url)

    const { userId } = getRequestMeta(req)
    logEvent({
      user_id:     userId,
      log_type:    'booking',
      action:      'booking_documents_uploaded',
      description: `${files.length} document(s) uploaded${bookingRef ? ` for booking ${bookingRef}` : ''}`,
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

