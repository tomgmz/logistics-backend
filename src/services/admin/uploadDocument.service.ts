import { cloudinary } from '../../lib/cloudinary.js'
import { Readable } from 'stream'

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
          return reject(error ?? new Error('Cloudinary upload failed'))
        }
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
  await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' })
}