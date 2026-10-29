import type { Request } from 'express'

/**
 * Server-side paging for the web tables.
 *
 * A list endpoint pages only when the caller sends both `page` and `limit`;
 * without them it returns the whole list as before, so the dropdowns, pickers
 * and mobile screens that read the same endpoint keep working unchanged.
 *
 * Lists that are filtered in SQL page with LIMIT/OFFSET (trucks, bookings,
 * logs). Lists whose rows are assembled in code (names joined in, derived
 * statuses) are filtered here on the server and sliced with `paginate`, so the
 * browser still only receives one page.
 */

export const MAX_PAGE_LIMIT = 100

export interface PageQuery {
  page:  number
  limit: number
}

export interface PageMeta {
  total:      number
  page:       number
  limit:      number
  totalPages: number
}

/** `{ page, limit }` when the request asks for a page, else null (whole list). */
export function pageQuery(req: Request): PageQuery | null {
  const page  = Number(req.query.page)
  const limit = Number(req.query.limit)
  if (!Number.isFinite(page) || !Number.isFinite(limit) || page < 1 || limit < 1) return null
  return { page: Math.floor(page), limit: Math.min(Math.floor(limit), MAX_PAGE_LIMIT) }
}

/**
 * One page of `rows`. A page past the end (the last row on it was archived, a
 * filter shrank the list) comes back as the last page, and `meta.page` says
 * which page that was so the table can follow.
 */
export function paginate<T>(rows: T[], q: PageQuery): { data: T[]; meta: PageMeta } {
  const total      = rows.length
  const totalPages = Math.max(1, Math.ceil(total / q.limit))
  const page       = Math.min(q.page, totalPages)
  const from       = (page - 1) * q.limit
  return {
    data: rows.slice(from, from + q.limit),
    meta: { total, page, limit: q.limit, totalPages },
  }
}

/** The trimmed, lower-cased `search` query param ('' when absent). */
export function searchQuery(req: Request, key = 'search'): string {
  const v = req.query[key]
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/** True when any of `values` contains `q` (already lower-cased); '' matches everything. */
export function matchesSearch(q: string, values: (string | number | null | undefined)[]): boolean {
  if (!q) return true
  return values.some((v) => v != null && String(v).toLowerCase().includes(q))
}

/** A string query param, or `fallback` when it is missing or empty. */
export function queryString(req: Request, key: string, fallback = ''): string {
  const v = req.query[key]
  return typeof v === 'string' && v !== '' ? v : fallback
}

/**
 * The common case for a small list endpoint: with `page` + `limit`, filter by
 * `search` over `fields` and send one page plus `meta.unfiltered` (the count
 * before searching, for "3 of 40"); without them, the whole list as before.
 */
export function pagedList<T>(
  req: Request,
  rows: T[],
  fields: (row: T) => (string | number | null | undefined)[],
): { data: T[]; meta?: PageMeta & { unfiltered: number } } {
  const paging = pageQuery(req)
  if (!paging) return { data: rows }
  const q = searchQuery(req)
  const { data, meta } = paginate(rows.filter((r) => matchesSearch(q, fields(r))), paging)
  return { data, meta: { ...meta, unfiltered: rows.length } }
}
