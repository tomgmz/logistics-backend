/**
 * Document Management — one library over every file the system keeps.
 *
 * Most rows are DERIVED: they are read from the table that owns the file
 * (a booking's transaction documents, a trip's pickup photo, a stop's signed
 * receipt photo, a vehicle's odometer photo or service receipt) and are
 * read-only here, because they are evidence recorded by someone else's flow.
 * Only `staff` rows — paperwork attached from the Document Management page,
 * stored in the `documents` table — can be reviewed or archived.
 */

/** Paperwork staff can attach (the `documents.document_type` whitelist). */
export const STAFF_DOCUMENT_TYPES = [
  'delivery_receipt',
  'trip_ticket',
  'dtr',
  'proof_of_delivery',
  'purchase_order',
  'maintenance_record',
  'other',
] as const
export type StaffDocumentType = (typeof STAFF_DOCUMENT_TYPES)[number]

/** Files that come from other flows and are listed read-only. */
export const DERIVED_DOCUMENT_TYPES = [
  'transaction_document',
  'pickup_proof',
  'delivery_proof',
  'odometer_photo',
  'service_receipt',
] as const
export type DerivedDocumentType = (typeof DERIVED_DOCUMENT_TYPES)[number]

export type LibraryDocumentType = StaffDocumentType | DerivedDocumentType

export const LIBRARY_DOCUMENT_TYPES: readonly LibraryDocumentType[] = [
  ...DERIVED_DOCUMENT_TYPES,
  ...STAFF_DOCUMENT_TYPES,
]

/**
 * What a client sees in their own transaction history: their attachments, every
 * pickup and drop-off proof photo, and the shipment paperwork staff attached to
 * the booking. Left out are the files about OUR side of the job: a driver's
 * Daily Time Record, maintenance records, and the fleet's odometer photos and
 * service receipts. Staff uploads also appear only once they are approved and
 * not archived, so a rejected or mistaken upload never reaches the client.
 */
export const CLIENT_VISIBLE_DOCUMENT_TYPES: readonly LibraryDocumentType[] = [
  'transaction_document',
  'pickup_proof',
  'delivery_proof',
  'delivery_receipt',
  'proof_of_delivery',
  'trip_ticket',
  'purchase_order',
  'other',
]

/** The client-safe projection of a library row: no staff names, notes or override reasons. */
export interface ClientBookingDocument {
  doc_key:     string
  doc_type:    LibraryDocumentType
  source:      DocumentSource
  file_url:    string
  file_name:   string
  uploaded_at: string | null
  detail:      string | null
}

/** Who put the file into the system. */
export type DocumentSource = 'client' | 'driver' | 'fleet' | 'staff'

export type ReviewStatus = 'pending' | 'approved' | 'rejected'

export interface LibraryDocument {
  doc_key:            string
  doc_type:           LibraryDocumentType
  doc_group:          'booking' | 'fleet'
  source:             DocumentSource
  file_url:           string
  file_name:          string
  uploaded_at:        string | null
  detail:             string | null
  notes:              string | null
  /** Proof taken outside the stop's geofence, and the driver's reason. */
  override_reason:    string | null
  booking_id:         string | null
  reference_number:   string | null
  booking_status:     string | null
  company_name:       string | null
  truck_id:           string | null
  plate_number:       string | null
  uploaded_by:        string | null
  uploaded_by_name:   string | null
  uploaded_by_role:   string | null
  /** Staff documents only; null for derived rows. */
  document_id:        string | null
  review_status:      ReviewStatus | null
  rejection_reason:   string | null
  reviewed_at:        string | null
  reviewed_by_name:   string | null
  archived_at:        string | null
  bytes:              number | null
}

export interface DocumentListQuery {
  search?:        string
  types?:         LibraryDocumentType[]
  group?:         'booking' | 'fleet'
  review_status?: ReviewStatus
  booking_id?:    string
  date_from?:     string
  date_to?:       string
  archived?:      'hide' | 'only'
  sort?:          'asc' | 'desc'
  page:           number
  limit:          number
}

export interface DocumentCounts {
  total:          number
  pending_review: number
  by_type:        Partial<Record<LibraryDocumentType, number>>
}
