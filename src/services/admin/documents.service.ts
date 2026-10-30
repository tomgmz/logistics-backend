import { putFile, safeFileName, isFileRef } from '../../lib/storage.js'
import { planBookingUploads, DuplicateBookingFileError } from '../../lib/booking-files.js'
import { logEvent } from '../../lib/log-event.js'
import { logSystemError } from '../../lib/log-system.js'
import { badRequest, conflict, HttpError, notFound } from '../../lib/http-error.js'
import * as DocumentsModel from '../../models/admin/documents.model.js'
import { OTHER_LABEL_MAX } from '../../types/documents.types.js'
import type {
  DocumentFolderQuery,
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

export function searchClientsForUpload(search: string) {
  return DocumentsModel.searchClients(search)
}

export function listOtherLabels() {
  return DocumentsModel.findOtherLabels()
}

export function contractFolderStats(clientId: string, archived: 'hide' | 'only') {
  return DocumentsModel.findContractFolderStats(clientId, archived)
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
 * type the uploader typed in); a Contract goes on a client, in that client's
 * Contract folder. Either way a same-named file is numbered and the same file
 * already there is refused (lib/booking-files.ts).
 */
export async function uploadStaffDocuments(input: {
  bookingId:    string | null
  clientId:     string | null
  documentType: StaffDocumentType
  otherLabel:   string | null
  notes:        string | null
  files:        Express.Multer.File[]
  uploadedBy:   string | null
}) {
  if (input.files.length === 0) throw badRequest('Choose at least one file to upload.')

  const otherLabel = input.documentType === 'other' ? input.otherLabel?.trim().replace(/\s+/g, ' ') ?? '' : null
  if (otherLabel !== null && !otherLabel) throw badRequest('Type what kind of document this is.')
  if (otherLabel && otherLabel.length > OTHER_LABEL_MAX) throw badRequest(`Keep the document type to ${OTHER_LABEL_MAX} characters.`)

  // Where it is filed, and what is already there to compare against.
  let target: { booking_id: string | null; client_id: string | null; folder: string; label: string }
  let existing: { name: string; url: string }[]
  if (input.documentType === 'contract') {
    if (!input.clientId) throw badRequest('Choose the client this contract is for.')
    const client = await DocumentsModel.findClient(input.clientId)
    if (!client) throw notFound('That client could not be found.')
    target   = { booking_id: null, client_id: client.client_id, folder: `client_documents/${client.client_id}/contracts`, label: `client ${client.company_name ?? client.client_id}` }
    existing = await DocumentsModel.findClientContracts(client.client_id)
  } else {
    if (!input.bookingId) throw badRequest('Choose the booking this document is for.')
    const booking = await DocumentsModel.findBookingRef(input.bookingId)
    if (!booking) throw notFound('That booking could not be found.')
    target   = { booking_id: booking.booking_id, client_id: null, folder: `${FOLDER}/${booking.reference_number ?? booking.booking_id}/staff`, label: `booking ${booking.reference_number ?? booking.booking_id}` }
    existing = await DocumentsModel.findBookingAttachedFiles(booking.booking_id)
  }

  let plan: { displayName: string }[]
  try {
    plan = await planBookingUploads(input.files, existing.map((e) => ({ name: e.name, ref: isFileRef(e.url) ? e.url : null })))
  } catch (err) {
    if (err instanceof DuplicateBookingFileError) {
      throw conflict(input.documentType === 'contract' ? err.message.replace('this booking', 'this client') : err.message)
    }
    throw err
  }

  const uploaded = await Promise.all(input.files.map((f, i) => uploadOne(f, target.folder, plan[i].displayName)))

  const ids = await DocumentsModel.insertStaffDocuments(uploaded.map((u, i) => ({
    booking_id:    target.booking_id,
    client_id:     target.client_id,
    document_type: input.documentType,
    other_label:   otherLabel,
    file_url:      u.url,
    original_name: plan[i].displayName,
    public_id:     u.public_id,
    file_format:   u.format,
    bytes:         u.bytes,
    notes:         input.notes,
    uploaded_by:   input.uploadedBy,
  })))

  logEvent({
    log_type:    'document_activity',
    action:      'document_uploaded',
    description: `${ids.length} ${otherLabel ? `Other (${otherLabel})` : input.documentType} document(s) attached to ${target.label}: ${input.files.map((f) => f.originalname).join(', ')}`,
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
