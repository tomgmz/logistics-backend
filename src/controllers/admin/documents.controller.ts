import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { statusOf } from '../../lib/http-error.js'
import * as DocumentsService from '../../services/admin/documents.service.js'
import { pageQuery, paginate } from '../../lib/paginate.js'
import {
  LIBRARY_DOCUMENT_TYPES,
  type DocumentFolderLevel,
  type DocumentListQuery,
  type DocumentScope,
  type LibraryDocumentType,
  type ReviewStatus,
} from '../../types/documents.types.js'

/**
 * The Fleet Manager's Document Management holds vehicle files only (the
 * Fleet group). Every endpoint applies this on the server; the page hiding
 * clients and bookings is only the view of it.
 */
function scopeOf(req: Request): DocumentScope {
  return req.user?.role === 'fleet_manager' ? 'fleet' : 'all'
}

function outOfScope(res: Response) {
  res.status(403).json({ status: 'error', message: 'You can only work with vehicle documents.' })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// staff:<uuid>, txn:<uuid>:<n>, trip-stop:<uuid>, … (see documents.model.ts)
const DOC_KEY_RE = /^[a-z-]+:[0-9a-f-]{36}(?::\d{1,3})?$/
/** Most files one download may hold. */
export const MAX_DOWNLOAD_KEYS = 100

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
  const truck  = str(req.query.truck_id)
  const client = str(req.query.client_id)
  const from   = str(req.query.date_from)
  const to     = str(req.query.date_to)
  const keys   = (str(req.query.keys) ?? '').split(',').filter((k) => DOC_KEY_RE.test(k)).slice(0, MAX_DOWNLOAD_KEYS)
  const fleetOnly = scopeOf(req) === 'fleet'

  return {
    search:        str(req.query.search)?.slice(0, 100),
    types:         types.length ? types : undefined,
    // The Fleet Manager's group is always Fleet, whatever was asked for.
    group:         fleetOnly ? 'fleet' : group === 'booking' || group === 'fleet' || group === 'client' ? group : undefined,
    review_status: ['pending', 'approved', 'rejected'].includes(review ?? '') ? review as ReviewStatus : undefined,
    booking_id:    booking && UUID_RE.test(booking) ? booking : undefined,
    truck_id:      truck && UUID_RE.test(truck) ? truck : undefined,
    client_id:     client && UUID_RE.test(client) ? client : undefined,
    date_from:     from && DATE_RE.test(from) ? from : undefined,
    date_to:       to && DATE_RE.test(to) ? to : undefined,
    archived:      req.query.archived === 'only' ? 'only' : 'hide',
    sort:          req.query.sort === 'asc' ? 'asc' : 'desc',
    keys:          keys.length ? keys : undefined,
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

/** Folder rows for one level: clients, a client's bookings, or vehicles. */
export async function listFolders(req: Request, res: Response) {
  try {
    const level   = str(req.query.level)
    const client  = str(req.query.client_id)
    const booking = str(req.query.booking_id)
    const search  = str(req.query.search)?.slice(0, 100)
    const archived = req.query.archived === 'only' ? 'only' as const : 'hide' as const
    const paging  = pageQuery(req)

    // The Fleet Manager's folders are the vehicles, nothing above or beside them.
    if (scopeOf(req) === 'fleet' && level !== 'vehicles') return outOfScope(res)

    // The Documents page's top level, paged: every client folder, then (while
    // searching) the matching bookings across all clients, then the Fleet
    // folder (not while searching, and not on the clients-only view). Each row
    // says which `kind` it is.
    if (level === 'root') {
      const [clients, bookings, vehicles] = await Promise.all([
        DocumentsService.listFolders({ level: 'clients', search, archived }),
        search ? DocumentsService.listFolders({ level: 'bookings', search, archived }) : Promise.resolve([]),
        !search && req.query.fleet === '1' ? DocumentsService.listFolders({ level: 'vehicles', archived }) : Promise.resolve([]),
      ])
      const rows: any[] = [
        ...clients.map((c) => ({ ...c, kind: 'client' })),
        ...bookings.map((b) => ({ ...b, kind: 'booking' })),
      ]
      if (vehicles.length > 0) {
        rows.push({
          kind: 'fleet', id: null, name: 'Fleet', client_id: null, company_name: null,
          booking_status: null, schedule_date: null,
          booking_count:  vehicles.length,
          file_count:     vehicles.reduce((n, v) => n + v.file_count, 0),
          // Vehicle paperwork goes through review too (2026-11-08).
          pending_review: vehicles.reduce((n, v) => n + v.pending_review, 0),
          last_upload:    vehicles.reduce<string | null>((m, v) => (v.last_upload && (!m || v.last_upload > m) ? v.last_upload : m), null),
        })
      }
      const { data, meta } = paginate(rows, paging ?? { page: 1, limit: rows.length || 1 })
      return res.status(200).json({ status: 'success', data, meta })
    }

    if (level !== 'clients' && level !== 'bookings' && level !== 'vehicles') {
      return res.status(400).json({ status: 'error', message: 'Unknown folder level.' })
    }
    let data: any[] = await DocumentsService.listFolders({
      level:      level as DocumentFolderLevel,
      client_id:  client === 'none' || (client && UUID_RE.test(client)) ? client : undefined,
      booking_id: booking && UUID_RE.test(booking) ? booking : undefined,
      search,
      archived,
    })
    // Inside a client's folder: its bookings. The client's contracts are listed
    // there too, as files (the page reads them with group=client), not as a
    // separate Contract folder (removed 2026-11-18).
    if (level === 'bookings' && client && UUID_RE.test(client) && !booking) {
      data = data.map((d) => ({ ...d, kind: 'booking' }))
    }
    if (paging) {
      const { data: page, meta } = paginate(data, paging)
      return res.status(200).json({ status: 'success', data: page, meta })
    }
    res.status(200).json({ status: 'success', data })
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
  if (scopeOf(req) === 'fleet') return outOfScope(res)
  try {
    const data = await DocumentsService.searchBookingsForUpload(str(req.query.search)?.slice(0, 100) ?? '')
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err)
  }
}

/** A booking's drop-offs and their proof state, for a Proof of Delivery's Drop-off choice. */
export async function listBookingDropoffs(req: Request, res: Response) {
  if (scopeOf(req) === 'fleet') return outOfScope(res)
  const bookingId = param(req.params.bookingId)
  if (!UUID_RE.test(bookingId)) return res.status(400).json({ status: 'error', message: 'Invalid booking id.' })
  try {
    const data = await DocumentsService.listBookingDropoffs(bookingId)
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err)
  }
}

/** The vehicle picker for uploading a vehicle's paperwork. */
export async function searchVehicles(req: Request, res: Response) {
  try {
    const data = await DocumentsService.searchVehiclesForUpload(str(req.query.search)?.slice(0, 100) ?? '')
    res.status(200).json({ status: 'success', data })
  } catch (err) {
    fail(res, err)
  }
}

/**
 * Types typed in for Other before, most used first: the suggestions under the
 * field. `?for=vehicle` lists the ones typed on vehicles; the Fleet Manager
 * always gets those.
 */
export async function listOtherLabels(req: Request, res: Response) {
  try {
    const target = scopeOf(req) === 'fleet' || req.query.for === 'vehicle' ? 'vehicle' : 'booking'
    res.status(200).json({ status: 'success', data: await DocumentsService.listOtherLabels(target) })
  } catch (err) {
    fail(res, err)
  }
}

export async function uploadDocuments(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await DocumentsService.uploadStaffDocuments({
      bookingId:    req.body.booking_id ?? null,
      truckId:      req.body.truck_id ?? null,
      destinationId: req.body.destination_id ?? null,
      documentType: req.body.document_type,
      otherLabel:   req.body.other_label ?? null,
      notes:        req.body.notes?.trim() || null,
      files:        (req.files as Express.Multer.File[] | undefined) ?? [],
      uploadedBy:   userId,
      scope:        scopeOf(req),
    })
    res.status(201).json({ status: 'success', data })
  } catch (err) {
    fail(res, err)
  }
}

export async function archiveDocument(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await DocumentsService.setDocumentArchived(param(req.params.id), true, userId, scopeOf(req))
    res.status(200).json({ status: 'success' })
  } catch (err) {
    fail(res, err)
  }
}

export async function restoreDocument(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await DocumentsService.setDocumentArchived(param(req.params.id), false, userId, scopeOf(req))
    res.status(200).json({ status: 'success' })
  } catch (err) {
    fail(res, err)
  }
}
