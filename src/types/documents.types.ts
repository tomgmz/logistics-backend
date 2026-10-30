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

/**
 * Paperwork staff can attach (the `documents.document_type` whitelist), in the
 * order the upload form lists them. A Contract belongs to a client, not a
 * booking, and is staff only. Proof of Delivery and Other go on a booking;
 * Other carries the type the uploader typed in (other_label) and is staff only.
 */
export const STAFF_DOCUMENT_TYPES = [
  'contract',
  'proof_of_delivery',
  'other',
] as const
export type StaffDocumentType = (typeof STAFF_DOCUMENT_TYPES)[number]

/** The longest type an uploader may type in for Other. */
export const OTHER_LABEL_MAX = 60

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
 * pickup and drop-off proof photo, and staff's Proof of Delivery. Left out are
 * Other documents and contracts (staff only), and the fleet's odometer photos
 * and service receipts. Staff uploads also appear only once they are approved
 * and not archived, so a rejected or mistaken upload never reaches the client.
 */
export const CLIENT_VISIBLE_DOCUMENT_TYPES: readonly LibraryDocumentType[] = [
  'transaction_document',
  'pickup_proof',
  'delivery_proof',
  'proof_of_delivery',
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
  /** `client`: a contract, filed under the client rather than a booking. */
  doc_group:          'booking' | 'fleet' | 'client'
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
  client_id:          string | null
  /** Other only: the type the uploader typed in. */
  other_label:        string | null
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
  group?:         'booking' | 'fleet' | 'client'
  review_status?: ReviewStatus
  booking_id?:    string
  /** A client's Contract folder (with group 'client'). */
  client_id?:     string
  /** A vehicle's folder: every file recorded against that truck. */
  truck_id?:      string
  date_from?:     string
  date_to?:       string
  archived?:      'hide' | 'only'
  sort?:          'asc' | 'desc'
  /** Exactly these rows (doc_key), whatever the other filters say: a download of ticked documents. */
  keys?:          string[]
  page:           number
  limit:          number
}

/**
 * Document Management's folders: a client holds booking folders; the Fleet
 * folder holds one folder per vehicle. Built from the same library rows, so a
 * folder only exists while it has files.
 */
export type DocumentFolderLevel = 'clients' | 'bookings' | 'vehicles'

export interface DocumentFolderQuery {
  level:       DocumentFolderLevel
  /** bookings: one client's ('none' = bookings with no client on record). */
  client_id?:  string
  /** bookings: just this one (the deep link from a booking). */
  booking_id?: string
  search?:     string
  archived?:   'hide' | 'only'
}

export interface DocumentFolder {
  id:             string | null
  name:           string | null
  client_id:      string | null
  company_name:   string | null
  booking_status: string | null
  schedule_date:  string | null
  booking_count:  number
  file_count:     number
  pending_review: number
  last_upload:    string | null
}

export interface DocumentCounts {
  total:          number
  pending_review: number
  by_type:        Partial<Record<LibraryDocumentType, number>>
}
