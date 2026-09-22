import ReportModel from '../../models/driver/report.model.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { logEvent } from '../../lib/log-event.js'
import { supabase } from '../../lib/supabase.js'
import type {
  DriverReport,
  CreateDriverReportInput,
  ReportStatus,
  IncidentType,
} from '../../types/driver/report.types.js'
import type { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'

/**
 * Driver reports — the "Reports" module in the driver app.
 *
 * Two gestures, one record. The quick alert is sent in one tap under a countdown
 * and may carry nothing but a position; the detailed form is the same row with
 * everything the driver had time to type. Keeping them together means operations
 * reads one queue, and a driver who sends the alert first can open it again and
 * add the detail rather than filing a second, duplicate report.
 *
 * Everything here notifies. A report nobody sees is worse than no report at all:
 * the driver believes help is coming.
 */

/** Who gets told. Fleet own the vehicle, operations own the delivery. */
const RESPONDER_ROLES = ['operations_manager', 'fleet_manager', 'admin']

const INCIDENT_LABEL: Record<IncidentType, string> = {
  accident:         'Accident',
  vehicle_breakdown: 'Vehicle breakdown',
  health_emergency: 'Health emergency',
  security_threat:  'Security threat',
}

/** A quick alert sent without picking a tile is still an emergency. */
function incidentLabel(type: IncidentType | null): string {
  return type ? INCIDENT_LABEL[type] : 'Unspecified emergency'
}

/* ── Raising one ──────────────────────────────────────────────────────────── */

export interface ReportActor {
  userId?: string | null
  role?:   string | null
}

/**
 * File a report and tell the people who can act on it.
 *
 * The vehicle is resolved from the booking when the caller didn't name one: the
 * driver app knows which delivery it is on, and asking a driver in an emergency
 * to identify their own truck by id is the kind of friction that turns a report
 * into no report.
 */
export async function createReportService(
  driverId: string,
  input: CreateDriverReportInput,
  actor: ReportActor,
): Promise<DriverReport> {
  // A detailed report is a form, and the form's own required fields are the
  // incident type and a description. The quick alert is deliberately exempt —
  // that is the entire point of it.
  if (input.source === 'detailed') {
    if (!input.incident_type) throw new Error('Choose the type of incident')
    if (!input.description?.trim()) throw new Error('Describe what happened')
  }

  const truckId = input.truck_id ?? (input.booking_id ? await truckOnBooking(input.booking_id) : null)

  const report = await ReportModel.create(driverId, { ...input, truck_id: truckId })

  logEvent({
    user_id:     actor.userId,
    log_type:    'vehicle_activity',
    action:      input.source === 'quick' ? 'driver_quick_alert' : 'driver_report_filed',
    description:
      `Driver raised a ${input.source === 'quick' ? 'QUICK ALERT' : 'report'}: ${incidentLabel(report.incident_type)}` +
      (report.sub_type ? ` (${report.sub_type})` : '') +
      (report.trip_can_continue === false ? ' — the trip CANNOT continue' : ''),
  })

  void notifyResponders(report)

  return report
}

/** Which truck is out on this booking right now. Null when nothing is assigned. */
async function truckOnBooking(bookingId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('truck_assignments')
    .select('truck_id')
    .eq('booking_id', bookingId)
    .order('assigned_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    // A report must never fail because we could not name the vehicle.
    console.warn('[reports] could not resolve truck for booking', bookingId, error.message)
    return null
  }
  return (data as any)?.truck_id ?? null
}

/**
 * Fan the report out to whoever can respond — in-app row, realtime push into
 * their open dashboard, and a device push.
 *
 * Best effort and never thrown into the caller's path: the report is already
 * saved, and failing the driver's request because a push token expired would
 * lose the very thing we are trying not to lose.
 */
async function notifyResponders(report: DriverReport): Promise<void> {
  try {
    const recipients = await notificationModel.resolveRecipientsByRoles(RESPONDER_ROLES)
    if (recipients.length === 0) return

    // A quick alert, or anything that stops the truck, is an emergency; a
    // detailed report the trip survives is information. They are separate types
    // so a dashboard can sort them and a phone can ring differently for them.
    const urgent = report.source === 'quick' || report.trip_can_continue === false
    const type   = urgent ? 'driver.emergency' : 'driver.report'

    const plate = report.trucks?.plate_number
    const title = urgent
      ? `EMERGENCY — ${incidentLabel(report.incident_type)}${plate ? ` · ${plate}` : ''}`
      : `Driver report — ${incidentLabel(report.incident_type)}${plate ? ` · ${plate}` : ''}`

    const body = [
      report.sub_type,
      report.description?.trim(),
      report.trip_can_continue === false ? 'The trip cannot continue.' : null,
      report.address,
    ].filter(Boolean).join(' · ') || 'No further detail was given.'

    const data = {
      type,
      report_id:  report.report_id,
      booking_id: report.booking_id,
      source:     report.source,
      incident_type: report.incident_type,
      trip_can_continue: report.trip_can_continue,
      latitude:   report.latitude,
      longitude:  report.longitude,
    }

    const rows: CreateNotificationInput[] = recipients.map(({ user_id }) => ({
      user_id,
      type,
      title,
      body,
      booking_id: report.booking_id,
      data:       { ...data, action_url: `/admin/reports?report=${encodeURIComponent(report.report_id)}` },
    }))

    const inserted = await notificationModel.insertMany(rows)

    void Promise.allSettled(
      inserted.map((row: NotificationRow) =>
        broadcast(`notifications:user:${row.user_id}`, 'new_notification', row),
      ),
    )

    void push.sendToUsers(recipients.map((r) => r.user_id), { title, body, data })
  } catch (err) {
    console.error('[reports] could not notify responders', report.report_id, err)
  }
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

export function listDriverReportsService(driverId: string): Promise<DriverReport[]> {
  return ReportModel.findByDriverId(driverId)
}

export async function getReportService(reportId: string, driverId?: string | null): Promise<DriverReport> {
  const report = await ReportModel.findById(reportId)
  if (!report) throw new Error('Report not found')

  // A driver reads only their own. `driverId` is null for staff callers, who
  // read every report — that is the whole purpose of the operations queue.
  if (driverId && report.driver_id !== driverId) throw new Error('Report not found')

  return report
}

export function listAllReportsService(status?: ReportStatus | null): Promise<DriverReport[]> {
  return ReportModel.findAll(status)
}

/* ── Enriching a quick alert ──────────────────────────────────────────────── */

/**
 * Add detail to a report the driver already sent.
 *
 * The quick alert exists so a driver in trouble does not have to fill in a form
 * first. This is how the form gets filled in afterwards — same row, so the
 * responders watching it see it grow rather than getting a second alert.
 * Only fields the driver actually supplied are written.
 */
export async function enrichReportService(
  reportId: string,
  driverId: string,
  input: Partial<CreateDriverReportInput>,
): Promise<DriverReport> {
  const report = await getReportService(reportId, driverId)

  const patch: Record<string, unknown> = {}
  if (input.incident_type !== undefined) patch.incident_type = input.incident_type
  if (input.sub_type      !== undefined) patch.sub_type      = input.sub_type
  if (input.description   !== undefined) patch.description   = input.description
  if (input.address       !== undefined) patch.address       = input.address
  if (input.trip_can_continue !== undefined) patch.trip_can_continue = input.trip_can_continue

  // Photos and videos ACCUMULATE. A driver adding a second picture is adding to
  // the evidence, not replacing what they sent under a countdown.
  if (input.photo_urls?.length) {
    patch.photo_urls = [...(report.photo_urls ?? []), ...input.photo_urls]
  }
  if (input.video_urls?.length) {
    patch.video_urls = [...(report.video_urls ?? []), ...input.video_urls]
  }
  if (input.blowbagets_items) {
    patch.blowbagets_check = { items: input.blowbagets_items, checked_at: new Date().toISOString() }
  }

  if (Object.keys(patch).length === 0) return report

  // A quick alert that has been filled in is no longer a bare alert.
  if (report.source === 'quick' && (patch.description || patch.incident_type)) {
    patch.source = 'detailed'
  }

  return ReportModel.update(reportId, patch as Partial<DriverReport>)
}

/* ── Responding ───────────────────────────────────────────────────────────── */

/** Operations picks a report up, or closes it out. */
export async function setReportStatusService(
  reportId: string,
  status: Exclude<ReportStatus, 'reported'>,
  actor: ReportActor,
  resolutionNote?: string | null,
): Promise<DriverReport> {
  const report = await getReportService(reportId)
  const now    = new Date().toISOString()

  const patch: Record<string, unknown> = { status }
  if (status === 'acknowledged') {
    patch.acknowledged_by = actor.userId ?? null
    patch.acknowledged_at = now
  } else {
    patch.resolved_by     = actor.userId ?? null
    patch.resolved_at     = now
    patch.resolution_note = resolutionNote ?? null
    // Resolving something nobody acknowledged still means somebody saw it.
    if (!report.acknowledged_at) {
      patch.acknowledged_by = actor.userId ?? null
      patch.acknowledged_at = now
    }
  }

  const updated = await ReportModel.update(reportId, patch as Partial<DriverReport>)

  logEvent({
    user_id:     actor.userId,
    log_type:    'vehicle_activity',
    action:      `driver_report_${status}`,
    description: `Driver report ${reportId} marked ${status}` + (resolutionNote ? `: ${resolutionNote}` : ''),
  })

  return updated
}
