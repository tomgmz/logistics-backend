import { cloudinary } from '../../lib/cloudinary.js'
import { logEvent } from '../../lib/log-event.js'
import { logSystemError } from '../../lib/log-system.js'
import { badRequest, conflict, HttpError, notFound } from '../../lib/http-error.js'
import * as DocumentsModel from '../../models/admin/documents.model.js'
import type {
  DocumentListQuery,
  StaffDocumentType,
} from '../../types/documents.types.js'

export const DOCUMENT_EXPORT_ROW_CAP = 5_000

const FOLDER = 'booking_documents'

export async function listDocuments(q: DocumentListQuery) {
  const { page, limit, sort, ...filters } = q
  const [{ rows, total }, counts] = await Promise.all([
    DocumentsModel.findPage(q),
    DocumentsModel.countByType(filters),
  ])
  return { data: rows, total, page, limit, counts }
}

export async function exportDocuments(q: Omit<DocumentListQuery, 'page' | 'limit'>) {
  // One past the cap, so a full read tells us there was more behind it.
  const rows      = await DocumentsModel.findForExport(q, DOCUMENT_EXPORT_ROW_CAP + 1)
  const truncated = rows.length > DOCUMENT_EXPORT_ROW_CAP
  const exported  = truncated ? DOCUMENT_EXPORT_ROW_CAP : rows.length

  logEvent({
    log_type:    'data_export',
    action:      'documents_exported',
    description: `Exported ${exported} document row(s)${truncated ? ` (capped at ${DOCUMENT_EXPORT_ROW_CAP})` : ''}; filters: ${JSON.stringify(q)}`,
  })

  return { rows: truncated ? rows.slice(0, DOCUMENT_EXPORT_ROW_CAP) : rows, truncated }
}

export function searchBookingsForUpload(search: string) {
  return DocumentsModel.searchBookings(search)
}

/**
 * Same shape as the client booking-document upload: `auto` so photos and PDFs
 * land as image resources the browser can preview, while DOCX/XLSX land as raw.
 * Image resources get their format appended by Cloudinary, so the extension is
 * left off the public id for those (PDF included); raw files keep theirs.
 */
function uploadOne(file: Express.Multer.File, folder: string) {
  const ext      = file.originalname.split('.').pop()?.toLowerCase() ?? ''
  const baseName = file.originalname
    .replace(/\.[^/.]+$/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 55)
  const isRaw    = ['docx', 'doc', 'xlsx'].includes(ext)
  const publicId = isRaw ? `${baseName}.${ext}` : baseName

  return new Promise<{ url: string; public_id: string; format: string; bytes: number }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type:   'auto',
        public_id:       publicId,
        unique_filename: true,
        overwrite:       false,
        access_mode:     'public',
        tags:            ['staff_document'],
      },
      (error, result) => {
        if (error || !result) {
          logSystemError('documents.service', 'external_api', error ?? new Error('Cloudinary upload failed'), {
            folder, original_name: file.originalname,
          })
          return reject(error ?? new Error('Cloudinary upload failed'))
        }
        resolve({
          url:       result.secure_url,
          public_id: result.public_id,
          format:    result.format ?? ext,
          bytes:     result.bytes ?? 0,
        })
      },
    )
    stream.end(file.buffer)
  })
}

export async function uploadStaffDocuments(input: {
  bookingId:    string
  documentType: StaffDocumentType
  notes:        string | null
  files:        Express.Multer.File[]
  uploadedBy:   string | null
}) {
  if (input.files.length === 0) throw badRequest('Choose at least one file to upload.')

  const booking = await DocumentsModel.findBookingRef(input.bookingId)
  if (!booking) throw notFound('That booking could not be found.')

  const folder   = `${FOLDER}/${booking.reference_number ?? booking.booking_id}/staff`
  const uploaded = await Promise.all(input.files.map((f) => uploadOne(f, folder)))

  const ids = await DocumentsModel.insertStaffDocuments(uploaded.map((u, i) => ({
    booking_id:    booking.booking_id,
    document_type: input.documentType,
    file_url:      u.url,
    original_name: input.files[i].originalname,
    public_id:     u.public_id,
    file_format:   u.format,
    bytes:         u.bytes,
    notes:         input.notes,
    uploaded_by:   input.uploadedBy,
  })))

  logEvent({
    log_type:    'document_activity',
    action:      'document_uploaded',
    description: `${ids.length} ${input.documentType} document(s) attached to booking ${booking.reference_number ?? booking.booking_id}: ${input.files.map((f) => f.originalname).join(', ')}`,
  })

  return { document_ids: ids }
}

export async function reviewStaffDocument(input: {
  documentId: string
  decision:   'approved' | 'rejected'
  reason:     string | null
  reviewerId: string | null
}) {
  const doc = await DocumentsModel.findStaffDocument(input.documentId)
  if (!doc) throw notFound('Document not found.')
  if (doc.archived_at) throw conflict('This document is archived. Restore it before reviewing.')
  // Four eyes: whoever attached a document does not also sign it off.
  if (input.reviewerId && doc.uploaded_by === input.reviewerId) {
    throw new HttpError(403, 'You cannot review a document you uploaded. Ask another reviewer.')
  }
  if (input.decision === 'rejected' && !input.reason?.trim()) {
    throw badRequest('Give a reason for rejecting the document.')
  }

  const ok = await DocumentsModel.reviewStaffDocument(
    input.documentId, input.decision, input.reason?.trim() || null, input.reviewerId,
  )
  // The conditional update found nothing: someone else decided it first.
  if (!ok) throw conflict('This document has already been reviewed.')

  logEvent({
    log_type:    'document_activity',
    action:      input.decision === 'approved' ? 'document_approved' : 'document_rejected',
    description: `${input.decision === 'approved' ? 'Approved' : 'Rejected'} "${doc.original_name ?? doc.file_url}"${input.reason ? `: ${input.reason.trim()}` : ''}`,
  })
}

export async function setDocumentArchived(documentId: string, archived: boolean, actorId: string | null) {
  const doc = await DocumentsModel.findStaffDocument(documentId)
  if (!doc) throw notFound('Document not found.')

  const ok = await DocumentsModel.setArchived(documentId, archived, actorId)
  if (!ok) throw conflict(archived ? 'This document is already archived.' : 'This document is not archived.')

  logEvent({
    log_type:    'document_activity',
    action:      archived ? 'document_archived' : 'document_restored',
    description: `${archived ? 'Archived' : 'Restored'} "${doc.original_name ?? doc.file_url}"`,
  })
}
