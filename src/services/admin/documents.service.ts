import { putFile, safeFileName, isFileRef } from '../../lib/storage.js'
import { planBookingUploads, DuplicateBookingFileError } from '../../lib/booking-files.js'
import { logEvent } from '../../lib/log-event.js'
import { logSystemError } from '../../lib/log-system.js'
import { badRequest, conflict, HttpError, notFound } from '../../lib/http-error.js'
import * as DocumentsModel from '../../models/admin/documents.model.js'
import * as ProofModel from '../../models/admin/proof-missing.model.js'
import { OTHER_LABEL_MAX, VEHICLE_DOCUMENT_TYPES } from '../../types/documents.types.js'
import type {
  DocumentFolderQuery,
  DocumentListQuery,
  DocumentScope,
  StaffDocumentType,
  UploadableDocumentType,
} from '../../types/documents.types.js'

const OUT_OF_SCOPE = 'You can only work with vehicle documents.'

/** For the audit description. */
const TYPE_WORDS: Record<StaffDocumentType, string> = {
  contract:             'Contract',
  proof_of_delivery:    'Proof of Delivery',
  vehicle_registration: 'Vehicle Registration',
  vehicle_insurance:    'Insurance',
  other:                'Other',
}

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

export async function listFolders(q: DocumentFolderQuery) {
  return DocumentsModel.findFolders(q)
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

/** A booking's drop-offs with their proof state, for the upload form's Drop-off choice. */
export function listBookingDropoffs(bookingId: string) {
  return ProofModel.findDropoffProof(bookingId)
}

export function listOtherLabels(target: 'booking' | 'vehicle') {
  return DocumentsModel.findOtherLabels(target)
}

export function searchVehiclesForUpload(search: string) {
  return DocumentsModel.searchVehicles(search)
}

/**
 * Same shape as the client booking-document upload: a random folder per file
 * (so the link cannot be guessed) holding the file under its original name (so
 * a download is offered with that name).
 */
async function uploadOne(file: Express.Multer.File, folder: string, displayName: string) {
  const fileName = safeFileName(displayName)
  try {
    const { ref, key, bytes } = await putFile(file.buffer, { folder, fileName, contentType: file.mimetype })
    return { url: ref, public_id: key, format: fileName.split('.').pop() ?? '', bytes }
  } catch (err) {
    logSystemError('documents.service', 'external_api', err, { folder, original_name: file.originalname })
    throw err
  }
}

/**
 * Staff paperwork. Proof of Delivery and Other go on a booking (Other with the
 * type the uploader typed in); vehicle papers (and Other) on a vehicle. A
 * same-named file is numbered and the same file already there is refused
 * (lib/booking-files.ts). Contract is no longer uploaded and nothing waits for
 * review (user 2026-11-27): every upload is saved approved and counts at once.
 */
export async function uploadStaffDocuments(input: {
  bookingId:    string | null
  truckId:      string | null
  /** The drop-off a Proof of Delivery proves; on a one-drop-off booking it is filled in. */
  destinationId?: string | null
  documentType: UploadableDocumentType
  otherLabel:   string | null
  notes:        string | null
  files:        Express.Multer.File[]
  uploadedBy:   string | null
  scope:        DocumentScope
}) {
  if (input.files.length === 0) throw badRequest('Choose at least one file to upload.')
  // The Fleet Manager files on vehicles only.
  if (input.scope === 'fleet' && !input.truckId) throw new HttpError(403, OUT_OF_SCOPE)

  const otherLabel = input.documentType === 'other' ? input.otherLabel?.trim().replace(/\s+/g, ' ') ?? '' : null
  if (otherLabel !== null && !otherLabel) throw badRequest('Type what kind of document this is.')
  if (otherLabel && otherLabel.length > OTHER_LABEL_MAX) throw badRequest(`Keep the document type to ${OTHER_LABEL_MAX} characters.`)

  // Where it is filed, and what is already there to compare against.
  let target: { booking_id: string | null; client_id: string | null; truck_id: string | null; folder: string; label: string }
  let existing: { name: string; url: string }[]
  if (input.truckId) {
    if (!(VEHICLE_DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) {
      throw badRequest('That type cannot be filed on a vehicle.')
    }
    const truck = await DocumentsModel.findVehicle(input.truckId)
    if (!truck) throw notFound('That vehicle could not be found.')
    if (truck.status === 'archived') throw conflict('That vehicle is archived. Restore it before adding documents.')
    // Under vehicle_documents/, a sensitive prefix (lib/storage.ts): short-lived links.
    target   = { booking_id: null, client_id: null, truck_id: truck.truck_id, folder: `vehicle_documents/${truck.truck_id}`, label: `vehicle ${truck.plate_number ?? truck.truck_id}` }
    existing = await DocumentsModel.findVehicleDocuments(truck.truck_id)
  } else {
    if (input.documentType === 'vehicle_registration' || input.documentType === 'vehicle_insurance') {
      throw badRequest('Choose the vehicle this document belongs to.')
    }
    if (!input.bookingId) throw badRequest('Choose the booking this document is for.')
    const booking = await DocumentsModel.findBookingRef(input.bookingId)
    if (!booking) throw notFound('That booking could not be found.')
    target   = { booking_id: booking.booking_id, client_id: null, truck_id: null, folder: `${FOLDER}/${booking.reference_number ?? booking.booking_id}/staff`, label: `booking ${booking.reference_number ?? booking.booking_id}` }
    existing = await DocumentsModel.findBookingAttachedFiles(booking.booking_id)
  }

  // Which drop-off a Proof of Delivery proves: it clears that drop-off's
  // "Proof missing". A booking with one drop-off needs no choice.
  let destinationId: string | null = null
  if (input.documentType === 'proof_of_delivery' && target.booking_id) {
    if (input.destinationId) {
      if (!(await ProofModel.destinationOnBooking(input.destinationId, target.booking_id))) {
        throw badRequest('That drop-off is not on this booking.')
      }
      destinationId = input.destinationId
    } else {
      destinationId = await ProofModel.findOnlyDestination(target.booking_id)
    }
  } else if (input.destinationId) {
    throw badRequest('Only a Proof of Delivery is filed on a drop-off.')
  }

  let plan: { displayName: string }[]
  try {
    plan = await planBookingUploads(input.files, existing.map((e) => ({ name: e.name, ref: isFileRef(e.url) ? e.url : null })))
  } catch (err) {
    if (err instanceof DuplicateBookingFileError) {
      throw conflict(target.truck_id ? err.message.replace('this booking', 'this vehicle') : err.message)
    }
    throw err
  }

  const uploaded = await Promise.all(input.files.map((f, i) => uploadOne(f, target.folder, plan[i].displayName)))

  // No review step (2026-11-27): saved approved; reviewed_by stays empty.
  const approvedAt = new Date().toISOString()

  const ids = await DocumentsModel.insertStaffDocuments(uploaded.map((u, i) => ({
    booking_id:    target.booking_id,
    client_id:     target.client_id,
    truck_id:      target.truck_id,
    destination_id: destinationId,
    document_type: input.documentType,
    other_label:   otherLabel,
    file_url:      u.url,
    original_name: plan[i].displayName,
    public_id:     u.public_id,
    file_format:   u.format,
    bytes:         u.bytes,
    notes:         input.notes,
    uploaded_by:   input.uploadedBy,
    status:        'approved',
    reviewed_at:   approvedAt,
  })))

  logEvent({
    log_type:    'document_activity',
    action:      'document_uploaded',
    description: `${ids.length} ${otherLabel ? `Other (${otherLabel})` : TYPE_WORDS[input.documentType]} document(s) attached to ${target.label}${destinationId ? ' (for one drop-off)' : ''}: ${input.files.map((f) => f.originalname).join(', ')}`,
  })

  return { document_ids: ids, needs_review: false }
}

export async function setDocumentArchived(documentId: string, archived: boolean, actorId: string | null, scope: DocumentScope) {
  const doc = await DocumentsModel.findStaffDocument(documentId)
  if (!doc || (scope === 'fleet' && !doc.truck_id)) throw notFound('Document not found.')
  // Contracts are no longer kept here (2026-11-27): restored, one would sit in
  // no folder. They stay in the Archive module.
  if (!archived && doc.document_type === 'contract') {
    throw conflict('Contracts are no longer kept in Document Management, so this one stays archived.')
  }

  const ok = await DocumentsModel.setArchived(documentId, archived, actorId)
  if (!ok) throw conflict(archived ? 'This document is already archived.' : 'This document is not archived.')

  logEvent({
    log_type:    'document_activity',
    action:      archived ? 'document_archived' : 'document_restored',
    description: `${archived ? 'Archived' : 'Restored'} "${doc.original_name ?? doc.file_url}"`,
  })
}
