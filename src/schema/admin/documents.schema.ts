import { z } from 'zod'
import { OTHER_LABEL_MAX, UPLOADABLE_DOCUMENT_TYPES, VEHICLE_DOCUMENT_TYPES } from '../../types/documents.types.js'

// Multipart bodies arrive as strings; the files themselves are checked by the
// uploadDocuments multer middleware (type, size, count).
// Multipart sends an empty field as '', which means "not given".
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)

/**
 * Proof of Delivery and Other need a booking; Other also needs its typed-in
 * type. Vehicle Registration and Insurance need a vehicle; Other may name a
 * vehicle instead of a booking (one or the other, never both). Contract is no
 * longer uploaded (2026-11-27).
 */
export const uploadStaffDocumentsSchema = z.object({
  booking_id:    z.preprocess(blankToNull, z.string().uuid('Choose the booking this document belongs to').nullable().optional()),
  truck_id:      z.preprocess(blankToNull, z.string().uuid('Choose the vehicle this document belongs to').nullable().optional()),
  // The drop-off a Proof of Delivery proves (optional; filled in on a one-drop-off booking).
  destination_id: z.preprocess(blankToNull, z.string().uuid('Choose a drop-off on this booking').nullable().optional()),
  document_type: z.enum(UPLOADABLE_DOCUMENT_TYPES, { message: 'Choose Proof of Delivery, Vehicle Registration, Insurance or Other' }),
  other_label:   z.preprocess(blankToNull, z.string().trim().max(OTHER_LABEL_MAX, `Keep the document type to ${OTHER_LABEL_MAX} characters`).nullable().optional()),
  notes:         z.string().trim().max(500).optional().nullable(),
}).superRefine((v, ctx) => {
  const vehicleOnly = v.document_type === 'vehicle_registration' || v.document_type === 'vehicle_insurance'
  if (vehicleOnly || (v.document_type === 'other' && v.truck_id)) {
    if (!v.truck_id) ctx.addIssue({ code: 'custom', path: ['truck_id'], message: 'Choose the vehicle this document belongs to' })
    if (v.booking_id) ctx.addIssue({ code: 'custom', path: ['booking_id'], message: 'A vehicle document is not filed on a booking' })
  } else if (!v.booking_id) {
    ctx.addIssue({ code: 'custom', path: ['booking_id'], message: 'Choose the booking this document belongs to' })
  }
  if (v.truck_id && !(VEHICLE_DOCUMENT_TYPES as readonly string[]).includes(v.document_type)) {
    ctx.addIssue({ code: 'custom', path: ['document_type'], message: 'That type cannot be filed on a vehicle' })
  }
  if (v.destination_id && v.document_type !== 'proof_of_delivery') {
    ctx.addIssue({ code: 'custom', path: ['destination_id'], message: 'Only a Proof of Delivery is filed on a drop-off' })
  }
  if (v.document_type === 'other' && !v.other_label) {
    ctx.addIssue({ code: 'custom', path: ['other_label'], message: 'Type what kind of document this is' })
  }
})
