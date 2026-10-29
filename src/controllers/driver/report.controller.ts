import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { supabase } from '../../lib/supabase.js'
import {
  createReportService,
  listDriverReportsService,
  getReportService,
  listAllReportsService,
  enrichReportService,
  setReportStatusService,
  classifyReportService,
  getEmergencyContactService,
  incidentLabel,
} from '../../services/driver/report.service.js'
import { pageQuery, paginate, searchQuery, matchesSearch, queryString } from '../../lib/paginate.js'
import { reportScopeForRole, type ReportStatus } from '../../types/driver/report.types.js'

/**
 * The driver app's Reports module (this replaces the placeholder "Maintenance"
 * tab), plus the operations-side queue that reads the same rows.
 *
 * Everything a driver reaches here is scoped to the driver on the SESSION, never
 * to an id in the URL — the reports carry positions and photos of incidents, and
 * an id-in-the-URL read is exactly the kind of IDOR this system has had before.
 */

function reportActor(req: Request) {
  const { userId } = getRequestMeta(req)
  return { userId, role: req.user?.role ?? null }
}

/** The signed-in user's own driver_id, or null when they aren't a driver. */
async function myDriverId(req: Request): Promise<string | null> {
  const { userId } = getRequestMeta(req)
  if (!userId) return null

  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return (data as any)?.driver_id ?? null
}

function reportStatus(message: string): number {
  if (message.includes('not found'))  return 404
  if (message.includes('Choose the') || message.includes('Describe what')) return 400
  if (message.includes('already classified')) return 409
  return 500
}

export const createReport = async (req: Request, res: Response) => {
  try {
    const driverId = await myDriverId(req)
    if (!driverId) {
      return res.status(403).json({ status: 'error', message: 'Only a driver can file a report' })
    }

    const report = await createReportService(driverId, {
      booking_id:        req.body.booking_id ?? null,
      truck_id:          req.body.truck_id ?? null,
      source:            req.body.source === 'quick' ? 'quick' : 'detailed',
      incident_type:     req.body.incident_type ?? null,
      sub_type:          req.body.sub_type ?? null,
      description:       req.body.description ?? null,
      photo_urls:        Array.isArray(req.body.photo_urls) ? req.body.photo_urls : [],
      video_urls:        Array.isArray(req.body.video_urls) ? req.body.video_urls : [],
      latitude:          typeof req.body.latitude   === 'number' ? req.body.latitude   : null,
      longitude:         typeof req.body.longitude  === 'number' ? req.body.longitude  : null,
      accuracy_m:        typeof req.body.accuracy_m === 'number' ? req.body.accuracy_m : null,
      address:           req.body.address ?? null,
      speed_kmh:         typeof req.body.speed_kmh === 'number' ? req.body.speed_kmh : null,
      blowbagets_items:  req.body.blowbagets_items ?? null,
      trip_can_continue: typeof req.body.trip_can_continue === 'boolean' ? req.body.trip_can_continue : null,
    }, reportActor(req))

    // A quick alert is followed by a phone call, so hand back a fresh number in
    // the same round trip rather than making the phone ask for it separately.
    const call_contact = report.source === 'quick' ? await getEmergencyContactService() : undefined

    res.status(201).json({ status: 'success', data: report, ...(call_contact !== undefined ? { call_contact } : {}) })
  } catch (error: any) {
    res.status(reportStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

/** The on-duty number for the quick alert's call; the app caches it for no-data moments. */
export const getEmergencyContact = async (_req: Request, res: Response) => {
  const contact = await getEmergencyContactService()
  res.status(200).json({ status: 'success', data: contact })
}

export const listMyReports = async (req: Request, res: Response) => {
  try {
    const driverId = await myDriverId(req)
    if (!driverId) return res.status(200).json({ status: 'success', data: [] })

    const reports = await listDriverReportsService(driverId)
    res.status(200).json({ status: 'success', data: reports })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const getReport = async (req: Request, res: Response) => {
  try {
    // Staff read any report; a driver reads only their own. Passing the driver
    // id into the service is what enforces that — not a check up here that a
    // later caller could forget.
    const driverId = req.user?.role === 'driver' ? await myDriverId(req) : null
    const report   = await getReportService(
      param(req.params.reportId),
      driverId,
      reportScopeForRole(req.user?.role),
    )
    res.status(200).json({ status: 'success', data: report })
  } catch (error: any) {
    res.status(reportStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

export const enrichReport = async (req: Request, res: Response) => {
  try {
    const driverId = await myDriverId(req)
    if (!driverId) {
      return res.status(403).json({ status: 'error', message: 'Only a driver can add to their own report' })
    }

    const report = await enrichReportService(param(req.params.reportId), driverId, {
      incident_type:     req.body.incident_type,
      sub_type:          req.body.sub_type,
      description:       req.body.description,
      address:           req.body.address,
      photo_urls:        Array.isArray(req.body.photo_urls) ? req.body.photo_urls : undefined,
      video_urls:        Array.isArray(req.body.video_urls) ? req.body.video_urls : undefined,
      blowbagets_items:  req.body.blowbagets_items,
      trip_can_continue: req.body.trip_can_continue,
    })

    res.status(200).json({ status: 'success', data: report })
  } catch (error: any) {
    res.status(reportStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

/* ── Operations side ──────────────────────────────────────────────────────── */

export const listAllReports = async (req: Request, res: Response) => {
  try {
    const paging = pageQuery(req)
    if (paging) {
      // The Reports table: filters, search and the tab counts are worked out
      // here, and only the page on screen goes back.
      const all    = await listAllReportsService(null, reportScopeForRole(req.user?.role))
      const status = queryString(req, 'status', 'open')
      const type   = queryString(req, 'type', 'all')
      const q      = searchQuery(req)

      const counts = { all: all.length, open: 0, reported: 0, acknowledged: 0, resolved: 0, unclassified: 0 }
      for (const r of all) {
        counts[r.status]++
        if (r.status !== 'resolved') counts.open++
        if (r.status !== 'resolved' && !r.incident_type) counts.unclassified++
      }

      const rows = all.filter((r) => {
        if (status === 'open' && r.status === 'resolved') return false
        if (status !== 'open' && status !== 'all' && r.status !== status) return false
        if (type === 'unspecified' && r.incident_type !== null) return false
        if (type !== 'all' && type !== 'unspecified' && r.incident_type !== type) return false
        const u = r.drivers?.users
        return matchesSearch(q, [
          u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : null,
          r.trucks?.plate_number,
          r.bookings?.reference_number,
          r.sub_type,
          r.description,
          r.address,
          incidentLabel(r.incident_type),
        ])
      })
      const { data, meta } = paginate(rows, paging)
      return res.status(200).json({ status: 'success', data, meta: { ...meta, counts } })
    }

    const status = String(req.query.status ?? '') as ReportStatus | ''
    const reports = await listAllReportsService(status || null, reportScopeForRole(req.user?.role))
    res.status(200).json({ status: 'success', data: reports })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const setReportStatus = async (req: Request, res: Response) => {
  try {
    const next = req.body.status
    if (next !== 'acknowledged' && next !== 'resolved') {
      return res.status(400).json({
        status: 'error',
        message: "status must be 'acknowledged' or 'resolved'",
      })
    }

    const report = await setReportStatusService(
      param(req.params.reportId),
      next,
      reportActor(req),
      req.body.resolution_note ?? null,
      reportScopeForRole(req.user?.role),
    )
    res.status(200).json({ status: 'success', data: report })
  } catch (error: any) {
    res.status(reportStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

/** The desk classifies an "Unspecified Emergency". */
export const classifyReport = async (req: Request, res: Response) => {
  try {
    const report = await classifyReportService(
      param(req.params.reportId),
      req.body.incident_type,
      reportActor(req),
    )
    res.status(200).json({ status: 'success', data: report })
  } catch (error: any) {
    res.status(reportStatus(error.message)).json({ status: 'error', message: error.message })
  }
}
