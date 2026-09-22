import { cloudinary } from '../../lib/cloudinary.js'
import { Readable } from 'stream'
import { logEvent } from '../../lib/log-event.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

export interface UploadedDocument {
  url:          string
  public_id:    string
  original_name: string
  format:       string
  bytes:        number
}

export async function uploadDocumentToCloudinary(
  buffer:       Buffer,
  originalName: string,
  bookingRef?:  string,
): Promise<UploadedDocument> {
  const folder = bookingRef
    ? `booking_documents/${bookingRef}`
    : 'booking_documents'

  const baseName = originalName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const timestamp = Date.now()
  const public_id = `${folder}/${baseName}_${timestamp}`

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id,
        resource_type: 'raw',
        use_filename:  false,
        overwrite:     false,
        access_mode:   'public',
      },
      (error, result) => {
        if (error || !result) {
          // Provider failure -> system. The business fact (a document was
          // attached) never happened, so there is nothing to audit.
          logSystemError('uploadDocument.service', 'external_api', error ?? new Error('Cloudinary upload failed'), {
            public_id, original_name: originalName,
          })
          return reject(error ?? new Error('Cloudinary upload failed'))
        }
        logEvent({
          log_type:    'document_activity',
          action:      'document_uploaded',
          description: `Uploaded "${originalName}" (${result.bytes ?? 0} bytes) to ${result.public_id}`,
        })
        resolve({
          url:           result.secure_url,
          public_id:     result.public_id,
          original_name: originalName,
          format:        result.format ?? '',
          bytes:         result.bytes  ?? 0,
        })
      },
    )

    const readable = new Readable()
    readable.push(buffer)
    readable.push(null)
    readable.pipe(uploadStream)
  })
}

export async function uploadDocumentsToCloudinary(
  files:       Express.Multer.File[],
  bookingRef?: string,
): Promise<UploadedDocument[]> {
  return Promise.all(
    files.map((f) => uploadDocumentToCloudinary(f.buffer, f.originalname, bookingRef)),
  )
}

export async function deleteDocumentFromCloudinary(publicId: string): Promise<void> {
  // Signed DRs and proof photos are the evidence that a delivery happened, so
  // removing one must be attributable. Both feeds: who asked (audit) and
  // whether the provider actually did it (system) — a failed destroy used to
  // leave the DB pointing at a live URL with nothing recording either.
  logEvent({
    log_type:    'document_activity',
    action:      'document_deleted',
    description: `Requested deletion of ${publicId}`,
  })

  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' })
    if (result?.result && result.result !== 'ok') {
      logSystem({
        log_level:  'warn',
        event_type: 'external_api',
        source:     'uploadDocument.service',
        message:    `Cloudinary refused to delete ${publicId}: ${result.result}`,
        metadata:   { public_id: publicId, provider_result: result.result },
      })
    }
  } catch (err) {
    logSystemError('uploadDocument.service', 'external_api', err, { public_id: publicId })
    throw err
  }
}
