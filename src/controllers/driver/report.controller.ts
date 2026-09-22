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
} from '../../services/driver/report.service.js'
import type { ReportStatus } from '../../types/driver/report.types.js'

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
      blowbagets_items:  req.body.blowbagets_items ?? null,
      trip_can_continue: typeof req.body.trip_can_continue === 'boolean' ? req.body.trip_can_continue : null,
    }, reportActor(req))

    res.status(201).json({ status: 'success', data: report })
  } catch (error: any) {
    res.status(reportStatus(error.message)).json({ status: 'error', message: error.message })
  }
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
    const report   = await getReportService(param(req.params.reportId), driverId)
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
    const status = String(req.query.status ?? '') as ReportStatus | ''
    const reports = await listAllReportsService(status || null)
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
    )
    res.status(200).json({ status: 'success', data: report })
  } catch (error: any) {
    res.status(reportStatus(error.message)).json({ status: 'error', message: error.message })
  }
}
