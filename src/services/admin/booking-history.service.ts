import { pool } from '../../lib/database.js'
import { PAUSE_REASON_LABEL, type PauseReason } from '../../types/client/pause.types.js'
import { incidentLabel } from '../driver/report.service.js'
import type { IncidentType } from '../../types/driver/report.types.js'

/**
 * The History section of a transaction (Figma "transaction_history/History",
 * 2026-11-26): three groups of cards, each with its own time.
 *
 *   approvals    — who approved (or rejected) the booking, who assigned the driver and vehicle
 *   transaction  — the client's request, completion, the client's problem report
 *                  (resubmissions are added by the web from the booking's revisions)
 *   transit      — what happened on the road: start, arrivals, loading, delivery,
 *                  delay, pauses, driver reports, driver or vehicle changes, return
 *
 * Read from the tables that already record each step; nothing new is stored.
 * Every time is an ISO string with its zone. Oldest first in each group.
 */

export interface HistoryPerson {
  /** "Approved by:", "Requested by:"… */
  label: string
  name:  string | null
  /** users.role, turned into words on the web. 'client' for the client. */
  role:  string | null
}

export interface HistoryPlace {
  /** "Delivered at:", "Delayed at:"… */
  label:   string
  address: string
  /** "Pick-up point", "Drop-off 2". */
  kind:    string | null
}

export interface HistoryItem {
  key:      string
  at:       string | null
  /** Approvals and transaction cards show the date only; transit cards show the time too. */
  withTime: boolean
  title:    string
  by?:      HistoryPerson | null
  /** White lines under the title. */
  lines?:   string[]
  /** Yellow words after the last line ("Nov 27, 2026, 7:00 AM"). */
  accent?:  string | null
  place?:   HistoryPlace | null
  /** Orange line under the place ("Delayed for 1 hr 20 min"). */
  late?:    string | null
  /** Grey line at the bottom ("Trip 1 of 2"). */
  trip?:    string | null
  remarks?: string | null
  /** A coloured sentence at the bottom. */
  note?:    { text: string; tone: 'yellow' | 'orange' | 'red' } | null
  /** An "Assigned ⌃" list that opens and closes. */
  list?:    { title: string; rows: Array<{ label: string; value: string }> } | null
  /** A photo row (the load moved onto the new vehicle). Stored link; the web opens it in the viewer. */
  photo?:   { url: string; label: string } | null
}

export interface BookingHistory {
  approvals:   HistoryItem[]
  transaction: HistoryItem[]
  transit:     HistoryItem[]
}

const iso = (v: unknown): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const fullName = (f?: string | null, l?: string | null) => [f, l].filter(Boolean).join(' ').trim() || null

const SEAT_LABEL: Record<string, string> = {
  driver:        'Driver',
  second_driver: 'Second Driver',
  helper:        'Helper',
  vehicle:       'Vehicle',
}
const SEAT_ORDER = ['driver', 'second_driver', 'helper', 'vehicle']

/** "1 hr 20 min", "45 min". */
function minutesText(min: number): string {
  const m = Math.max(0, Math.round(min))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const r = m % 60
  if (d > 0) return [`${d} day${d === 1 ? '' : 's'}`, h ? `${h} hr` : ''].filter(Boolean).join(' ')
  if (h === 0) return `${r} min`
  return r ? `${h} hr ${r} min` : `${h} hr`
}

/** "Nov 27, 2026, 7:00 AM" from a bare date and time (Manila). */
function planText(date: string, time: string | null): string {
  const [y, mo, d] = date.slice(0, 10).split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = `${months[mo - 1]} ${d}, ${y}`
  if (!time) return day
  const [h, m] = time.split(':').map(Number)
  return `${day}, ${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** Manila calendar day of an instant, "YYYY-MM-DD". */
function manilaDay(at: string): string {
  return new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 10)
}

export async function bookingHistory(bookingId: string): Promise<BookingHistory | null> {
  const q = (sql: string) => pool.query(sql, [bookingId])

  const [bookingRes, crewRes, tripsRes, stopsRes, milestonesRes, pausesRes, reportsRes, claimsRes, deliveryRes, transferRes] = await Promise.all([
    q(`SELECT b.origin, b.schedule_date::text AS schedule_date, b.call_time::text AS call_time, b.status,
              b.created_at AT TIME ZONE 'UTC' AS created_at,
              b.gm_status, b.approval_remarks, b.rejection_reason,
              b.gm_reviewed_at, b.gm_reviewed_role, ru.first_name AS rf, ru.last_name AS rl, ru.role AS r_role,
              b.ops_assigned_at, b.ops_assigned_role, au.first_name AS af, au.last_name AS al, au.role AS a_role,
              b.cancelled_at AT TIME ZONE 'UTC' AS cancelled_at, cu.first_name AS cf, cu.last_name AS cl, cu.role AS c_role,
              b.completion_confirmed_at, b.completion_confirmed_role, b.completion_auto,
              ku.first_name AS kf, ku.last_name AS kl,
              b.client_issue_note, b.client_issue_reported_at, b.client_issue_resolved_at, b.client_issue_resolution_note,
              iu.first_name AS if_, iu.last_name AS il, iu.role AS i_role,
              b.pickup_arrived_at, b.delayed_since, b.delay_minutes, b.fleet_return_at,
              b.resubmission_count,
              clu.first_name AS clf, clu.last_name AS cll, cl.company_name
         FROM bookings b
         LEFT JOIN users ru  ON ru.user_id = b.gm_reviewed_by
         LEFT JOIN users au  ON au.user_id = b.ops_assigned_by
         LEFT JOIN users cu  ON cu.user_id = b.cancelled_by
         LEFT JOIN users ku  ON ku.user_id = b.completion_confirmed_by
         LEFT JOIN users iu  ON iu.user_id = b.client_issue_resolved_by
         LEFT JOIN clients cl ON cl.client_id = b.client_id
         LEFT JOIN users clu ON clu.user_id = cl.user_id
        WHERE b.booking_id = $1`),
    q(`SELECT c.changed_at, c.seat, c.old_label, c.new_label, c.source, c.reason, c.changed_by_role,
              u.first_name, u.last_name
         FROM booking_crew_changes c
         LEFT JOIN users u ON u.user_id = c.changed_by
        WHERE c.booking_id = $1
        ORDER BY c.changed_at`),
    q(`SELECT trip_id, trip_number, status, pickup_proof_at, pickup_proof_override_reason
         FROM booking_trips WHERE booking_id = $1 AND status <> 'cancelled' ORDER BY trip_number`),
    q(`SELECT s.trip_stop_id, s.trip_id, s.status, s.delivered_at, s.proof_at, s.proof_override_reason,
              d.address, d.sequence_order
         FROM booking_trip_stops s
         JOIN booking_trips t ON t.trip_id = s.trip_id
         LEFT JOIN booking_destinations d ON d.destination_id = s.destination_id
        WHERE t.booking_id = $1 AND t.status <> 'cancelled'`),
    q(`SELECT m.trip_id, m.trip_stop_id, m.at, m.source
         FROM stop_milestones m WHERE m.booking_id = $1 AND m.stage = 'arrived'`),
    q(`SELECT p.pause_id, p.paused_at, p.resumed_at, p.resumed_via, p.reason, p.note, p.resume_note, p.report_id,
              p.expected_resume_date::text AS expected_resume_date, p.expected_resume_call_time::text AS expected_resume_call_time,
              pu.first_name AS pf, pu.last_name AS pl, pu.role AS p_role,
              su.first_name AS sf, su.last_name AS sl, su.role AS s_role
         FROM booking_pauses p
         LEFT JOIN users pu ON pu.user_id = p.paused_by
         LEFT JOIN users su ON su.user_id = p.resumed_by
        WHERE p.booking_id = $1`),
    q(`SELECT r.report_id, r.incident_type, r.sub_type, r.status, r.created_at, r.resolved_at, r.resolution_note,
              r.trip_can_continue, du.first_name AS df, du.last_name AS dl,
              xu.first_name AS xf, xu.last_name AS xl, xu.role AS x_role
         FROM driver_reports r
         LEFT JOIN drivers dr ON dr.driver_id = r.driver_id
         LEFT JOIN users du ON du.user_id = dr.user_id
         LEFT JOIN users xu ON xu.user_id = r.resolved_by
        WHERE r.booking_id = $1`),
    q(`SELECT c.claimed_at, nu.first_name AS nf, nu.last_name AS nl
         FROM booking_nav_claims c
         LEFT JOIN drivers nd ON nd.driver_id = c.driver_id LEFT JOIN users nu ON nu.user_id = nd.user_id
        WHERE c.booking_id = $1 AND c.took_over_from IS NOT NULL`),
    // pickup_time is a zoneless column holding UTC: the moment the driver set off.
    q(`SELECT pickup_time AT TIME ZONE 'UTC' AS started_at FROM deliveries WHERE booking_id = $1`),
    // A vehicle replaced mid-delivery: the load has to move onto the new one.
    q(`SELECT replacement_id, trip_id, replaced_at, transfer_confirmed_at, transfer_photo_url,
              COALESCE(nt.plate_number, r.new_vehicle_plate) AS new_plate
         FROM crew_replacements r
         LEFT JOIN trucks nt ON nt.truck_id = r.new_truck_id
        WHERE r.booking_id = $1 AND r.transfer_required`),
  ])

  const b = bookingRes.rows[0]
  if (!b) return null

  const approvals: HistoryItem[]   = []
  const transaction: HistoryItem[] = []
  const transit: HistoryItem[]     = []

  // ── Approvals ──────────────────────────────────────────────────────────────
  const gm = String(b.gm_status ?? '').toLowerCase()
  if (b.gm_reviewed_at || gm === 'approved' || gm === 'rejected') {
    const rejected = gm === 'rejected'
    const role = b.gm_reviewed_role ?? b.r_role ?? null
    approvals.push({
      key: 'review', at: iso(b.gm_reviewed_at), withTime: false,
      title: rejected ? 'Booking Rejected' : 'Booking Approval',
      by: { label: rejected ? 'Rejected by:' : 'Approved by:', name: fullName(b.rf, b.rl), role },
      remarks: (rejected ? b.rejection_reason : b.approval_remarks) ?? null,
      note: role === 'admin'
        ? { text: 'Decided by the Company Administrator in place of the General Manager.', tone: 'yellow' }
        : null,
    })
  }

  // The crew as first assigned: the first assignment write in the crew log
  // (one write changes several seats at the same moment).
  const crewRows = crewRes.rows as Array<Record<string, any>>
  const firstAssign = crewRows.find((r) => r.source === 'assigned' || r.source === 'backfill')
  const firstAt = firstAssign ? iso(firstAssign.changed_at) : null
  const assignedSeats = firstAt
    ? crewRows.filter((r) => iso(r.changed_at) === firstAt && r.new_label)
    : []
  if (b.ops_assigned_at || assignedSeats.length) {
    approvals.push({
      key: 'assignment', at: iso(b.ops_assigned_at) ?? firstAt, withTime: false,
      title: 'Driver and Vehicle Assignment',
      by: { label: 'Assigned by:', name: fullName(b.af, b.al), role: b.ops_assigned_role ?? b.a_role ?? null },
      list: assignedSeats.length
        ? {
            title: 'Assigned',
            rows: [...assignedSeats]
              .sort((x, y) => SEAT_ORDER.indexOf(x.seat) - SEAT_ORDER.indexOf(y.seat))
              .map((r) => ({ label: SEAT_LABEL[r.seat] ?? r.seat, value: r.new_label as string })),
          }
        : null,
    })
  }

  // A Company Administrator's rejection is stored as a cancellation.
  if (String(b.status).toLowerCase() === 'cancelled' && gm !== 'rejected') {
    approvals.push({
      key: 'cancelled', at: iso(b.cancelled_at), withTime: false,
      title: 'Booking Rejected',
      by: { label: 'Rejected by:', name: fullName(b.cf, b.cl), role: b.c_role ?? null },
      remarks: b.rejection_reason ?? null,
    })
  }

  // ── Transaction activities ────────────────────────────────────────────────
  transaction.push({
    key: 'request', at: iso(b.created_at), withTime: false,
    title: 'Booking Request',
    by: { label: 'Requested by:', name: fullName(b.clf, b.cll) ?? b.company_name ?? null, role: null },
  })

  // Driver or vehicle changed before the delivery started.
  const groups = new Map<string, Array<Record<string, any>>>()
  for (const r of crewRows) {
    if (r.source === 'assigned' || r.source === 'backfill') continue
    const k = `${iso(r.changed_at)}|${r.source}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  for (const [k, rows] of groups) {
    const r0 = rows[0]
    const at = iso(r0.changed_at)
    const driverSeat = rows.some((r) => r.seat !== 'vehicle')
    const what = r0.source === 'swapped'
      ? 'The main and second driver swapped places.'
      : driverSeat && rows.some((r) => r.seat === 'vehicle')
        ? 'The assigned driver and vehicle were replaced.'
        : driverSeat ? 'The assigned driver was replaced.' : 'The assigned vehicle was replaced.'
    const item: HistoryItem = {
      key: `crew-${k}`, at, withTime: true,
      title: driverSeat ? 'Driver Re-assigning' : 'Vehicle Re-assigning',
      lines: [what],
      by: { label: '', name: fullName(r0.first_name, r0.last_name), role: r0.changed_by_role ?? null },
      remarks: r0.reason ?? null,
      list: {
        title: 'Assigned',
        rows: [...rows]
          .sort((x, y) => SEAT_ORDER.indexOf(x.seat) - SEAT_ORDER.indexOf(y.seat))
          .map((r) => ({ label: SEAT_LABEL[r.seat] ?? r.seat, value: r.new_label ?? 'Removed' })),
      },
      note: r0.source === 'database'
        ? { text: 'Changed outside the app.', tone: 'orange' }
        : null,
    }
    // Before the start it is part of the booking; on the road it is transit.
    if (r0.source === 'reassigned') transaction.push(item)
    else transit.push(item)
  }

  if (b.client_issue_reported_at || b.client_issue_note) {
    transaction.push({
      key: 'issue', at: iso(b.client_issue_reported_at), withTime: true,
      title: 'Problem Reported by the Client',
      lines: b.client_issue_note ? [b.client_issue_note] : [],
      by: { label: 'Reported by:', name: fullName(b.clf, b.cll) ?? b.company_name ?? null, role: null },
      note: b.client_issue_resolved_at ? null : { text: 'The 8338 Logistics Services is resolving this issue.', tone: 'yellow' },
    })
  }
  if (b.client_issue_resolved_at) {
    transaction.push({
      key: 'issue-resolved', at: iso(b.client_issue_resolved_at), withTime: true,
      title: 'Problem Resolved',
      by: { label: 'Resolved by:', name: fullName(b.if_, b.il), role: b.i_role ?? null },
      remarks: b.client_issue_resolution_note ?? null,
    })
  }
  if (b.completion_confirmed_at) {
    transaction.push({
      key: 'completed', at: iso(b.completion_confirmed_at), withTime: true,
      title: 'Booking Completed',
      ...(b.completion_auto
        ? { lines: ['Completed automatically: nobody confirmed or reported a problem within 3 days of delivery.'] }
        : { by: { label: 'Confirmed by:', name: fullName(b.kf, b.kl), role: b.completion_confirmed_role ?? 'client' } }),
    })
  }

  // ── Transit activities ────────────────────────────────────────────────────
  const trips = tripsRes.rows as Array<Record<string, any>>
  const tripCount = trips.length
  const tripNo = new Map<string, number>(trips.map((t) => [t.trip_id as string, Number(t.trip_number)]))
  const tripLabel = (tripId: string | null | undefined) => {
    if (tripCount < 2 || !tripId) return null
    const n = tripNo.get(tripId)
    return n ? `Trip ${n} of ${tripCount}` : null
  }
  const firstTripId = trips[0]?.trip_id ?? null
  const officeNote = (reason: unknown) =>
    typeof reason === 'string' && /^Confirmed by the office/i.test(reason)
      ? { text: 'Recorded by the office in place of the assigned driver.', tone: 'yellow' as const }
      : null

  const startedAt = iso(deliveryRes.rows[0]?.started_at)
  if (startedAt) {
    transit.push({
      key: 'started', at: startedAt, withTime: true,
      title: 'Transit Started', lines: ['The driver started the transit.'], trip: tripLabel(firstTripId),
    })
  }

  // Arrivals: the stop-times "arrived" step, or the pick-up arrival the
  // delay check recorded for trip 1.
  const stops = stopsRes.rows as Array<Record<string, any>>
  const stopById = new Map(stops.map((s) => [s.trip_stop_id as string, s]))
  const pickupArrivalTrips = new Set<string>()
  for (const m of milestonesRes.rows as Array<Record<string, any>>) {
    const at = iso(m.at)
    if (!at) continue
    if (!m.trip_stop_id) {
      pickupArrivalTrips.add(m.trip_id)
      transit.push({
        key: `arr-p-${m.trip_id}`, at, withTime: true,
        title: 'Arrived at Pick Up', lines: [b.origin], trip: tripLabel(m.trip_id),
      })
    } else {
      const s = stopById.get(m.trip_stop_id)
      transit.push({
        key: `arr-d-${m.trip_stop_id}`, at, withTime: true,
        title: 'Arrived at Drop-Off', lines: [s?.address ?? 'Drop-off'], trip: tripLabel(m.trip_id),
      })
    }
  }
  if (b.pickup_arrived_at && !(firstTripId && pickupArrivalTrips.has(firstTripId))) {
    transit.push({
      key: 'arr-p-booking', at: iso(b.pickup_arrived_at), withTime: true,
      title: 'Arrived at Pick Up', lines: [b.origin], trip: tripLabel(firstTripId),
    })
  }

  // Late to the pick-up: measured against the client's pick-up time (trip 1 only).
  const due = b.schedule_date && b.call_time ? Date.parse(`${b.schedule_date}T${String(b.call_time).slice(0, 8)}+08:00`) : NaN
  const arrivedAt = b.pickup_arrived_at ? Date.parse(iso(b.pickup_arrived_at)!) : NaN
  if (Number.isFinite(due) && Number.isFinite(arrivedAt) && arrivedAt > due + 60_000) {
    transit.push({
      key: 'delay', at: iso(b.pickup_arrived_at), withTime: true,
      title: 'Delayed Delivery',
      place: { label: 'Delayed at:', address: b.origin, kind: 'Pick-up point' },
      late: `Delayed for ${minutesText((arrivedAt - due) / 60_000)}`,
    })
  } else if (b.delayed_since) {
    transit.push({
      key: 'delay', at: iso(b.delayed_since), withTime: true,
      title: 'Delayed Delivery',
      place: { label: 'Delayed at:', address: b.origin, kind: 'Pick-up point' },
      late: b.delay_minutes != null ? `Delayed for ${minutesText(Number(b.delay_minutes))} so far` : 'Not at the pick-up point yet',
    })
  }

  for (const t of trips) {
    if (!t.pickup_proof_at) continue
    transit.push({
      key: `load-${t.trip_id}`, at: iso(t.pickup_proof_at), withTime: true,
      title: 'Cargo Picked Up',
      place: { label: 'Picked up at:', address: b.origin, kind: 'Pick-up point' },
      trip: tripLabel(t.trip_id),
      note: officeNote(t.pickup_proof_override_reason),
    })
  }

  for (const s of stops) {
    if (s.status !== 'delivered' && s.status !== 'failed') continue
    const at = iso(s.delivered_at ?? s.proof_at)
    if (!at) continue
    const failed = s.status === 'failed'
    const reason = typeof s.proof_override_reason === 'string' ? s.proof_override_reason : null
    transit.push({
      key: `stop-${s.trip_stop_id}`, at, withTime: true,
      title: failed ? 'Delivery Failed' : 'Cargo Delivered',
      place: {
        label: failed ? 'Failed at:' : 'Delivered at:',
        address: s.address ?? 'Drop-off',
        kind: s.sequence_order != null ? `Drop-off ${s.sequence_order}` : null,
      },
      trip: tripLabel(s.trip_id),
      remarks: failed && reason ? reason.replace(/^Failed — reported by the office:\s*/i, '') : null,
      note: failed
        ? (reason && /office/i.test(reason) ? { text: 'Recorded by the office in place of the assigned driver.', tone: 'yellow' } : null)
        : officeNote(reason),
    })
  }

  // Driver reports, and their resolution.
  const reports = reportsRes.rows as Array<Record<string, any>>
  const reportById = new Map(reports.map((r) => [r.report_id as string, r]))
  const mergedResolutions = new Set<string>()
  for (const r of reports) {
    const what = [incidentLabel((r.incident_type ?? null) as IncidentType | null), r.sub_type].filter(Boolean).join(' · ')
    transit.push({
      key: `rep-${r.report_id}`, at: iso(r.created_at), withTime: true,
      title: 'Driver Report', lines: [what],
      note: r.status === 'resolved' ? null : { text: 'The 8338 Logistics Services is resolving this issue.', tone: 'yellow' },
    })
  }

  // Pauses: stopped, and started again.
  for (const p of pausesRes.rows as Array<Record<string, any>>) {
    const pausedAt = iso(p.paused_at)
    const reasonText = PAUSE_REASON_LABEL[p.reason as PauseReason] ?? null
    let accent: string | null = null
    let line = 'The transit is temporarily stopped.'
    if (p.expected_resume_date && pausedAt) {
      const tomorrow = new Date(Date.parse(`${manilaDay(pausedAt)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      line = `The transit is temporarily stopped. It is scheduled to continue ${p.expected_resume_date === tomorrow ? 'tomorrow' : 'on'}`
      accent = planText(p.expected_resume_date, p.expected_resume_call_time)
    }
    transit.push({
      key: `pause-${p.pause_id}`, at: pausedAt, withTime: true,
      title: 'Transit Paused',
      lines: [line],
      accent,
      remarks: [reasonText, p.note].filter(Boolean).join(': ') || null,
      by: fullName(p.pf, p.pl) ? { label: '', name: fullName(p.pf, p.pl), role: p.p_role ?? null } : null,
    })
    if (p.resumed_at) {
      const rep = p.report_id ? reportById.get(p.report_id) : null
      const together = rep?.resolved_at && Math.abs(Date.parse(iso(rep.resolved_at)!) - Date.parse(iso(p.resumed_at)!)) <= 5 * 60_000
      if (together) mergedResolutions.add(rep!.report_id)
      transit.push({
        key: `resume-${p.pause_id}`, at: iso(p.resumed_at), withTime: true,
        title: together ? 'Driver Report Resolved' : 'Transit Started',
        lines: ['The transit resumed.'],
        remarks: (together ? rep!.resolution_note : null) ?? p.resume_note ?? null,
        by: p.resumed_via === 'auto'
          ? null
          : fullName(p.sf, p.sl) ? { label: '', name: fullName(p.sf, p.sl), role: p.s_role ?? null } : null,
      })
    }
  }
  for (const r of reports) {
    if (!r.resolved_at || mergedResolutions.has(r.report_id)) continue
    transit.push({
      key: `rep-res-${r.report_id}`, at: iso(r.resolved_at), withTime: true,
      title: 'Driver Report Resolved',
      lines: [[incidentLabel((r.incident_type ?? null) as IncidentType | null), r.sub_type].filter(Boolean).join(' · ')],
      remarks: r.resolution_note ?? null,
      by: fullName(r.xf, r.xl) ? { label: '', name: fullName(r.xf, r.xl), role: r.x_role ?? null } : null,
    })
  }

  for (const c of claimsRes.rows as Array<Record<string, any>>) {
    transit.push({
      key: `nav-${iso(c.claimed_at)}`, at: iso(c.claimed_at), withTime: true,
      title: 'Navigation Moved',
      lines: [`Navigation moved to ${fullName(c.nf, c.nl) ?? 'the other driver'}'s phone.`],
    })
  }

  for (const t of transferRes.rows as Array<Record<string, any>>) {
    const done = !!t.transfer_confirmed_at
    transit.push({
      key: `transfer-${t.replacement_id}`, at: iso(done ? t.transfer_confirmed_at : t.replaced_at), withTime: true,
      title: done ? 'Load Moved' : 'Load Transfer Waiting',
      lines: [done
        ? `The load was moved to the new vehicle${t.new_plate ? ` (${t.new_plate})` : ''}.`
        : `The load has to be moved to the new vehicle${t.new_plate ? ` (${t.new_plate})` : ''}.`],
      trip: tripLabel(t.trip_id),
      photo: done && t.transfer_photo_url ? { url: t.transfer_photo_url, label: 'Load transfer photo' } : null,
      note: done ? null : { text: 'Waiting for the new driver to confirm the load was moved.', tone: 'orange' },
    })
  }

  if (b.fleet_return_at) {
    transit.push({
      key: 'return', at: iso(b.fleet_return_at), withTime: true,
      title: 'Back at the Parking', lines: ['The vehicle returned to the parking. The driver and vehicle are free again.'],
    })
  }

  const byTime = (x: HistoryItem, y: HistoryItem) => (Date.parse(x.at ?? '') || 0) - (Date.parse(y.at ?? '') || 0)
  return {
    approvals,
    transaction: transaction.sort(byTime),
    transit:     transit.sort(byTime),
  }
}
