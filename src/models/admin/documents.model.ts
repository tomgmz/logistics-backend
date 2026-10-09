import { pool } from '../../lib/database.js'
import { readInPages } from '../../lib/read-in-pages.js'
import { CLIENT_VISIBLE_DOCUMENT_TYPES } from '../../types/documents.types.js'
import type {
  ClientBookingDocument,
  DocumentCounts,
  DocumentListQuery,
  LibraryDocument,
  ReviewStatus,
  StaffDocumentType,
} from '../../types/documents.types.js'

/**
 * The library is one UNION ALL over every table that holds a file URL. Each
 * branch shapes its rows the same way; the outer query joins the booking,
 * client, vehicle and people once, and applies the filters.
 *
 * Naive timestamps (bookings.created_at) are UTC wall-clock and are tagged as
 * such, so every `uploaded_at` leaving here is a real instant.
 *
 * Single-trip bookings record pickup and stop proof on the booking and its
 * destinations; multi-trip bookings record them per trip. Where both carry the
 * same photo, the trip-level row wins and the booking-level one is skipped.
 */
const LIBRARY_SQL = `
  SELECT
    'staff:' || d.document_id          AS doc_key,
    d.document_type::text               AS doc_type,
    'booking'                           AS doc_group,
    'staff'                             AS source,
    d.file_url,
    COALESCE(d.original_name, regexp_replace(d.file_url, '^.*/', '')) AS file_name,
    d.uploaded_at,
    NULL::text                          AS detail,
    d.notes,
    NULL::text                          AS override_reason,
    d.booking_id,
    NULL::uuid                          AS truck_id,
    d.uploaded_by,
    d.document_id,
    d.status::text                      AS review_status,
    d.rejection_reason,
    d.reviewed_at,
    d.reviewed_by,
    d.archived_at,
    d.bytes
  FROM documents d
  WHERE d.booking_id IS NOT NULL

  UNION ALL
  SELECT
    'txn:' || b.booking_id || ':' || t.ord,
    'transaction_document', 'booking', 'client',
    t.url,
    regexp_replace(t.url, '^.*/', ''),
    b.created_at AT TIME ZONE 'UTC',
    'Attached by the client with the booking',
    NULL, NULL,
    b.booking_id, NULL,
    (SELECT cl.user_id FROM clients cl WHERE cl.client_id = b.client_id),
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM bookings b
  CROSS JOIN LATERAL unnest(b.transaction_documents) WITH ORDINALITY AS t(url, ord)
  WHERE t.url IS NOT NULL AND t.url <> ''

  UNION ALL
  SELECT
    'pickup:' || b.booking_id,
    'pickup_proof', 'booking', 'driver',
    b.pickup_proof_photo_url,
    regexp_replace(b.pickup_proof_photo_url, '^.*/', ''),
    b.pickup_proof_at,
    'Pickup at origin',
    NULL, b.pickup_proof_override_reason,
    b.booking_id, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM bookings b
  WHERE b.pickup_proof_photo_url IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM booking_trips x
       WHERE x.booking_id = b.booking_id
         AND x.pickup_proof_photo_url = b.pickup_proof_photo_url
    )

  UNION ALL
  SELECT
    'trip-pickup:' || tr.trip_id,
    'pickup_proof', 'booking', 'driver',
    tr.pickup_proof_photo_url,
    regexp_replace(tr.pickup_proof_photo_url, '^.*/', ''),
    tr.pickup_proof_at,
    'Trip ' || tr.trip_number || ' · pickup at origin',
    NULL, tr.pickup_proof_override_reason,
    tr.booking_id, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM booking_trips tr
  WHERE tr.pickup_proof_photo_url IS NOT NULL

  UNION ALL
  SELECT
    'stop:' || bd.destination_id,
    'delivery_proof', 'booking', 'driver',
    bd.proof_photo_url,
    regexp_replace(bd.proof_photo_url, '^.*/', ''),
    bd.proof_at,
    'Stop ' || bd.sequence_order || ' · ' || bd.address,
    NULL, bd.proof_override_reason,
    bd.booking_id, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM booking_destinations bd
  WHERE bd.proof_photo_url IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM booking_trip_stops x
       WHERE x.destination_id = bd.destination_id
         AND x.proof_photo_url = bd.proof_photo_url
    )

  UNION ALL
  SELECT
    'trip-stop:' || s.trip_stop_id,
    'delivery_proof', 'booking', 'driver',
    s.proof_photo_url,
    regexp_replace(s.proof_photo_url, '^.*/', ''),
    s.proof_at,
    'Trip ' || tr.trip_number || ' · stop ' || s.sequence_order || COALESCE(' · ' || bd.address, ''),
    NULL, s.proof_override_reason,
    tr.booking_id, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM booking_trip_stops s
  JOIN booking_trips tr        ON tr.trip_id = s.trip_id
  LEFT JOIN booking_destinations bd ON bd.destination_id = s.destination_id
  WHERE s.proof_photo_url IS NOT NULL

  UNION ALL
  SELECT
    'odometer:' || r.reading_id,
    'odometer_photo', 'fleet', 'fleet',
    r.photo_url,
    regexp_replace(r.photo_url, '^.*/', ''),
    r.recorded_at,
    CASE r.kind
      WHEN 'pre_trip'  THEN 'Before delivery'
      WHEN 'post_trip' THEN 'After delivery'
      WHEN 'service'   THEN 'At service'
      ELSE 'Initial reading'
    END || ' · ' || to_char(r.reading_km, 'FM999,999,999') || ' km',
    NULL, NULL,
    r.booking_id, r.truck_id, r.recorded_by,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM truck_odometer_readings r
  WHERE r.photo_url IS NOT NULL

  UNION ALL
  SELECT
    'service:' || sv.service_id,
    'service_receipt', 'fleet', 'fleet',
    sv.receipt_url,
    regexp_replace(sv.receipt_url, '^.*/', ''),
    sv.created_at,
    concat_ws(' · ', sv.workshop, sv.work_done),
    NULL, NULL,
    NULL, sv.truck_id, sv.recorded_by,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM truck_services sv
  WHERE sv.receipt_url IS NOT NULL
`

const FROM_SQL = `
  FROM (${LIBRARY_SQL}) l
  LEFT JOIN bookings b  ON b.booking_id = l.booking_id
  LEFT JOIN clients  c  ON c.client_id  = b.client_id
  LEFT JOIN trucks   t  ON t.truck_id   = l.truck_id
  LEFT JOIN users    up ON up.user_id   = l.uploaded_by
  LEFT JOIN users    rv ON rv.user_id   = l.reviewed_by
`

const SELECT_SQL = `
  SELECT
    l.doc_key, l.doc_type, l.doc_group, l.source, l.file_url, l.file_name,
    l.uploaded_at, l.detail, l.notes, l.override_reason,
    l.booking_id, b.reference_number, b.status::text AS booking_status, c.company_name,
    l.truck_id, t.plate_number,
    l.uploaded_by,
    NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), '') AS uploaded_by_name,
    up.role AS uploaded_by_role,
    l.document_id, l.review_status, l.rejection_reason, l.reviewed_at,
    NULLIF(TRIM(CONCAT_WS(' ', rv.first_name, rv.last_name)), '') AS reviewed_by_name,
    l.archived_at, l.bytes
`

const MANILA_DAY = `(l.uploaded_at AT TIME ZONE 'Asia/Manila')::date`

function likeTerm(search: string): string {
  return `%${search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
}

type Filters = Omit<DocumentListQuery, 'page' | 'limit' | 'sort'>

function buildWhere(f: Filters, omit: { types?: boolean; review?: boolean } = {}) {
  const where: string[] = []
  const params: unknown[] = []

  // Archiving only exists for staff documents; derived rows are never archived.
  where.push(f.archived === 'only' ? 'l.archived_at IS NOT NULL' : 'l.archived_at IS NULL')

  if (!omit.types && f.types && f.types.length > 0) {
    params.push(f.types)
    where.push(`l.doc_type = ANY($${params.length}::text[])`)
  }
  if (f.group) {
    params.push(f.group)
    where.push(`l.doc_group = $${params.length}`)
  }
  if (!omit.review && f.review_status) {
    params.push(f.review_status)
    where.push(`l.review_status = $${params.length}`)
  }
  if (f.booking_id) {
    params.push(f.booking_id)
    where.push(`l.booking_id = $${params.length}::uuid`)
  }
  if (f.date_from) {
    params.push(f.date_from)
    where.push(`${MANILA_DAY} >= $${params.length}::date`)
  }
  if (f.date_to) {
    params.push(f.date_to)
    where.push(`${MANILA_DAY} <= $${params.length}::date`)
  }
  if (f.search) {
    params.push(likeTerm(f.search))
    const i = params.length
    where.push(`(
      COALESCE(b.reference_number, '') ILIKE $${i} ESCAPE '\\' OR
      COALESCE(c.company_name, '')     ILIKE $${i} ESCAPE '\\' OR
      COALESCE(t.plate_number, '')     ILIKE $${i} ESCAPE '\\' OR
      l.file_name                      ILIKE $${i} ESCAPE '\\' OR
      COALESCE(l.detail, '')           ILIKE $${i} ESCAPE '\\' OR
      COALESCE(l.notes, '')            ILIKE $${i} ESCAPE '\\' OR
      COALESCE(CONCAT_WS(' ', up.first_name, up.last_name), '') ILIKE $${i} ESCAPE '\\'
    )`)
  }

  return { whereSql: `WHERE ${where.join(' AND ')}`, params }
}

function orderSql(sort: 'asc' | 'desc' = 'desc'): string {
  const dir = sort === 'asc' ? 'ASC' : 'DESC'
  // doc_key breaks ties so paging never repeats or skips a row.
  return `ORDER BY l.uploaded_at ${dir} NULLS LAST, l.doc_key ${dir}`
}

export async function findPage(q: DocumentListQuery): Promise<{ rows: LibraryDocument[]; total: number }> {
  const page   = Math.max(1, q.page)
  const limit  = Math.min(Math.max(1, q.limit), 100)
  const offset = (page - 1) * limit

  const { whereSql, params } = buildWhere(q)

  const [count, list] = await Promise.all([
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${FROM_SQL} ${whereSql}`, params),
    pool.query<LibraryDocument>(
      `${SELECT_SQL} ${FROM_SQL} ${whereSql} ${orderSql(q.sort)}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
  ])

  return { rows: list.rows, total: Number(count.rows[0]?.n ?? 0) }
}

/**
 * One booking's files as its client may see them (CLIENT_VISIBLE_DOCUMENT_TYPES),
 * oldest first so they read in the order the delivery happened.
 *
 * The staff-upload filter is in SQL, not left to the caller: an upload still
 * pending review, rejected, or archived must never leave the server for a client.
 */
export async function findClientVisibleForBooking(bookingId: string): Promise<ClientBookingDocument[]> {
  const { rows } = await pool.query<ClientBookingDocument>(
    `SELECT l.doc_key, l.doc_type, l.source, l.file_url, l.file_name, l.uploaded_at, l.detail
       FROM (${LIBRARY_SQL}) l
      WHERE l.booking_id = $1::uuid
        AND l.doc_type = ANY($2::text[])
        AND l.archived_at IS NULL
        AND (l.source <> 'staff' OR l.review_status = 'approved')
      ORDER BY l.uploaded_at ASC NULLS LAST, l.doc_key ASC`,
    [bookingId, CLIENT_VISIBLE_DOCUMENT_TYPES],
  )
  return rows
}

export async function findForExport(q: Omit<DocumentListQuery, 'page' | 'limit'>, cap: number): Promise<LibraryDocument[]> {
  const { whereSql, params } = buildWhere(q)
  return readInPages<LibraryDocument>(
    async (from, to) => {
      const { rows } = await pool.query<LibraryDocument>(
        `${SELECT_SQL} ${FROM_SQL} ${whereSql} ${orderSql(q.sort)}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, to - from + 1, from],
      )
      return { data: rows, error: null }
    },
    cap,
  )
}

/**
 * Counts for the filter chips. The type filter must not narrow its own chips
 * (picking one type would zero every other), and the "awaiting review" figure
 * ignores the review filter for the same reason.
 */
export async function countByType(f: Filters): Promise<DocumentCounts> {
  const { whereSql, params } = buildWhere(f, { types: true, review: true })
  const { rows } = await pool.query<{ doc_type: string; n: number; pending: number }>(
    `SELECT l.doc_type,
            COUNT(*)::int                                        AS n,
            COUNT(*) FILTER (WHERE l.review_status = 'pending')::int AS pending
     ${FROM_SQL} ${whereSql}
     GROUP BY l.doc_type`,
    params,
  )

  const by_type: DocumentCounts['by_type'] = {}
  let total = 0
  let pending_review = 0
  for (const r of rows) {
    by_type[r.doc_type as keyof DocumentCounts['by_type']] = Number(r.n)
    total          += Number(r.n)
    pending_review += Number(r.pending)
  }
  return { total, pending_review, by_type }
}

// ── Staff documents (the `documents` table) ────────────────────────────────

export interface StaffDocumentRow {
  document_id:   string
  booking_id:    string | null
  document_type: StaffDocumentType
  file_url:      string
  original_name: string | null
  uploaded_by:   string | null
  status:        ReviewStatus | 'archived'
  archived_at:   string | null
}

export interface NewStaffDocument {
  booking_id:    string
  document_type: StaffDocumentType
  file_url:      string
  original_name: string
  public_id:     string
  file_format:   string
  bytes:         number
  notes:         string | null
  uploaded_by:   string | null
}

export async function insertStaffDocuments(docs: NewStaffDocument[]): Promise<string[]> {
  if (docs.length === 0) return []
  const cols = ['booking_id', 'document_type', 'file_url', 'original_name', 'public_id', 'file_format', 'bytes', 'notes', 'uploaded_by'] as const
  const params: unknown[] = []
  const tuples = docs.map((d) => {
    const slots = cols.map((c) => {
      params.push(d[c])
      return `$${params.length}`
    })
    return `(${slots.join(', ')})`
  })

  const { rows } = await pool.query<{ document_id: string }>(
    `INSERT INTO documents (${cols.join(', ')}) VALUES ${tuples.join(', ')} RETURNING document_id`,
    params,
  )
  return rows.map((r) => r.document_id)
}

export async function findStaffDocument(documentId: string): Promise<StaffDocumentRow | null> {
  const { rows } = await pool.query<StaffDocumentRow>(
    `SELECT document_id, booking_id, document_type, file_url, original_name, uploaded_by, status, archived_at
       FROM documents WHERE document_id = $1`,
    [documentId],
  )
  return rows[0] ?? null
}

/**
 * Record a review decision. Conditional on the document still awaiting review
 * and not archived, so two reviewers racing on the same file cannot both win —
 * the loser gets false back and is told it has already been decided.
 */
export async function reviewStaffDocument(
  documentId: string,
  status: 'approved' | 'rejected',
  reason: string | null,
  reviewerId: string | null,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE documents
        SET status = $2, rejection_reason = $3, reviewed_at = now(), reviewed_by = $4
      WHERE document_id = $1 AND status = 'pending' AND archived_at IS NULL`,
    [documentId, status, status === 'rejected' ? reason : null, reviewerId],
  )
  return (rowCount ?? 0) > 0
}

export async function setArchived(documentId: string, archived: boolean, actorId: string | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    archived
      ? `UPDATE documents SET archived_at = now(), archived_by = $2 WHERE document_id = $1 AND archived_at IS NULL`
      : `UPDATE documents SET archived_at = NULL, archived_by = NULL WHERE document_id = $1 AND archived_at IS NOT NULL`,
    archived ? [documentId, actorId] : [documentId],
  )
  return (rowCount ?? 0) > 0
}

// ── Booking picker for the upload form ─────────────────────────────────────

export interface BookingOption {
  booking_id:       string
  reference_number: string | null
  status:           string
  schedule_date:    string | null
  company_name:     string | null
}

export async function searchBookings(search: string, limit = 10): Promise<BookingOption[]> {
  const params: unknown[] = []
  let where = ''
  if (search.trim()) {
    params.push(likeTerm(search.trim()))
    where = `WHERE b.reference_number ILIKE $1 ESCAPE '\\' OR COALESCE(c.company_name, '') ILIKE $1 ESCAPE '\\'`
  }
  params.push(limit)
  const { rows } = await pool.query<BookingOption>(
    `SELECT b.booking_id, b.reference_number, b.status::text AS status,
            to_char(b.schedule_date, 'YYYY-MM-DD') AS schedule_date, c.company_name
       FROM bookings b
       LEFT JOIN clients c ON c.client_id = b.client_id
       ${where}
      ORDER BY b.created_at DESC
      LIMIT $${params.length}`,
    params,
  )
  return rows
}

export async function findBookingRef(bookingId: string): Promise<{ booking_id: string; reference_number: string | null } | null> {
  const { rows } = await pool.query<{ booking_id: string; reference_number: string | null }>(
    `SELECT booking_id, reference_number FROM bookings WHERE booking_id = $1`,
    [bookingId],
  )
  return rows[0] ?? null
}
