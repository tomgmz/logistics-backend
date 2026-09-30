import { z } from 'zod'
import { STAFF_DOCUMENT_TYPES } from '../../types/documents.types.js'

// Multipart bodies arrive as strings; the files themselves are checked by the
// uploadDocuments multer middleware (type, size, count).
export const uploadStaffDocumentsSchema = z.object({
  booking_id:    z.string().uuid('Choose the booking this document belongs to'),
  document_type: z.enum(STAFF_DOCUMENT_TYPES),
  notes:         z.string().trim().max(500).optional().nullable(),
})

export const reviewDocumentSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason:   z.string().trim().max(500).optional().nullable(),
})
