import { z } from 'zod'
import { OTHER_LABEL_MAX, STAFF_DOCUMENT_TYPES } from '../../types/documents.types.js'

// Multipart bodies arrive as strings; the files themselves are checked by the
// uploadDocuments multer middleware (type, size, count).
// Multipart sends an empty field as '', which means "not given".
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)

/**
 * Proof of Delivery and Other need a booking; Other also needs its typed-in
 * type. A Contract needs a client instead (it is never a booking's).
 */
export const uploadStaffDocumentsSchema = z.object({
  booking_id:    z.preprocess(blankToNull, z.string().uuid('Choose the booking this document belongs to').nullable().optional()),
  client_id:     z.preprocess(blankToNull, z.string().uuid('Choose the client this contract is for').nullable().optional()),
  document_type: z.enum(STAFF_DOCUMENT_TYPES),
  other_label:   z.preprocess(blankToNull, z.string().trim().max(OTHER_LABEL_MAX, `Keep the document type to ${OTHER_LABEL_MAX} characters`).nullable().optional()),
  notes:         z.string().trim().max(500).optional().nullable(),
}).superRefine((v, ctx) => {
  if (v.document_type === 'contract') {
    if (!v.client_id) ctx.addIssue({ code: 'custom', path: ['client_id'], message: 'Choose the client this contract is for' })
  } else if (!v.booking_id) {
    ctx.addIssue({ code: 'custom', path: ['booking_id'], message: 'Choose the booking this document belongs to' })
  }
  if (v.document_type === 'other' && !v.other_label) {
    ctx.addIssue({ code: 'custom', path: ['other_label'], message: 'Type what kind of document this is' })
  }
})

export const reviewDocumentSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason:   z.string().trim().max(500).optional().nullable(),
})
