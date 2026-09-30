import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { statusOf } from '../../lib/http-error.js'
import * as DocumentsService from '../../services/admin/documents.service.js'
import {
  LIBRARY_DOCUMENT_TYPES,
  type DocumentListQuery,
  type LibraryDocumentType,
  type ReviewStatus,
} from '../../types/documents.types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

// Shared by the list and the export so both read the filters the same way.
// Anything unrecognised is dropped rather than passed to SQL.
function filtersFrom(req: Request): Omit<DocumentListQuery, 'page' | 'limit'> {
  const types = (str(req.query.types) ?? '')
    .split(',')
    .filter((t): t is LibraryDocumentType => (LIBRARY_DOCUMENT_TYPES as readonly string[]).includes(t))
  const group  = str(req.query.group)
  const review = str(req.query.review_status)
  const booking = str(req.query.booking_id)
  const from   = str(req.query.date_from)
  const to     = str(req.query.date_to)

  return {
    search:        str(req.query.search)?.slice(0, 100),
    types:         types.length ? types : undefined,
    group:         group === 'booking' || group === 'fleet' ? group : undefined,
    review_status: ['pending', 'approved', 'rejected'].includes(review ?? '') ? review as ReviewStatus : undefined,
    booking_id:    booking && UUID_RE.test(booking) ? booking : undefined,
    date_from:     from && DATE_RE.test(from) ? from : undefined,
    date_to:       to && DATE_RE.test(to) ? to : undefined,
    archived:      req.query.archived === 'only' ? 'only' : 'hide',
    sort:          req.query.sort === 'asc' ? 'asc' : 'desc',
  }
}

function fail(res: Response, err: unknown) {
  const status = statusOf(err)
  res.status(status).json({
    status:  'error',
    message: status === 500 ? 'Something went wrong. Please try again.' : (err as Error).message,
  })
  if (status === 500) console.error('DOCUMENTS ERROR:', err)
}

export async function listDocuments(req: Request, res: Response) {
  try {
    const data = await DocumentsService.listDocuments({
      ...filtersFrom(req),
      page:  Number(req.query.page)  || 1,
      limit: Number(req.query.limit) || 25,
    })
    res.status(200).json({ status: 'success', ...data })
  } catch (err) {
    fail(res, err)
  }
}

/** Rows, not a file — the browser builds the .xlsx (see the audit-log export). */
export async function exportDocuments(req: Request, res: Response) {
  try {
    const { rows, truncated } = await DocumentsService.exportDocuments(filtersFrom(req))
    res.status(200).json({ status: 'success', data: rows, meta: { truncated, count: rows.length } })
  } catch (err) {
    fail(res, err)
  }
}

export async function searchBookings(req: Request, res: Response) {
  try {
    const data = await DocumentsService.searchBookingsForUpload(str(req.query.search)?.slice(0, 100) ?? '')
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err)
  }
}

export async function uploadDocuments(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await DocumentsService.uploadStaffDocuments({
      bookingId:    req.body.booking_id,
      documentType: req.body.document_type,
      notes:        req.body.notes?.trim() || null,
      files:        (req.files as Express.Multer.File[] | undefined) ?? [],
      uploadedBy:   userId,
    })
    res.status(201).json({ status: 'success', data })
  } catch (err) {
    fail(res, err)
  }
}

export async function reviewDocument(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await DocumentsService.reviewStaffDocument({
      documentId: param(req.params.id),
      decision:   req.body.decision,
      reason:     req.body.reason ?? null,
      reviewerId: userId,
    })
    res.status(200).json({ status: 'success' })
  } catch (err) {
    fail(res, err)
  }
}

export async function archiveDocument(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await DocumentsService.setDocumentArchived(param(req.params.id), true, userId)
    res.status(200).json({ status: 'success' })
  } catch (err) {
    fail(res, err)
  }
}

export async function restoreDocument(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await DocumentsService.setDocumentArchived(param(req.params.id), false, userId)
    res.status(200).json({ status: 'success' })
  } catch (err) {
    fail(res, err)
  }
}
