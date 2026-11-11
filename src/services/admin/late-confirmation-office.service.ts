import { pool } from '../../lib/database.js'
import TripModel from '../../models/client/trip.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { announceRouteChanged, recordStopDelivered, recordTripLoaded } from '../client/trip.service.js'
import { LATE_REASON_TEXT, signalLateChanged, type LateReason } from '../driver/late-confirmation.service.js'

/**
 * The office's side of a late drop-off confirmation (late-confirmation.service):
 * the list on a booking, Accept and Dismiss, what the swap dialog shows, and
 * one list of what happened on the delivery, in time order.
 *
 * Accept records the drop-off with the DRIVER's own photo and position, as if
 * it had landed in time; who accepted it is in the audit log. Dismiss needs a
 * reason and leaves the drop-off as it is (the office then confirms it another
 * way, or reports a problem).
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v))

export interface LateConfirmationRow {
  late_id:         string
  /** 'pickup' = a run's loading; 'dropoff' = one drop-off. */
  kind:            'pickup' | 'dropoff'
  trip_stop_id:    string | null
  trip_number:     number | null
  stop_number:     number | null
  address:         string | null
  stop_status:     string
  driver_name:     string | null
  confirmed_at:    string | null
  received_at:     string
  proof_photo_url: string | null
  latitude:        number | null
  longitude:       number | null
  distance_m:      number | null
  override_reason: string | null
  reasons:         LateReason[]
  reason_text:     string[]
  status:          'pending' | 'accepted' | 'dismissed' | 'superseded'
  resolved_at:     string | null
  resolved_by_name: string | null
  resolution_note: string | null
}

export async function listLateConfirmations(bookingId: string): Promise<LateConfirmationRow[]> {
  const { rows } = await pool.query(
    `SELECT lc.*, t.trip_number, d.sequence_order AS stop_number, d.address,
            CASE WHEN lc.kind = 'pickup'
                 THEN CASE WHEN t.status IN ('in_transit','completed') THEN 'delivered' ELSE 'pending' END
                 ELSE s.status END AS stop_status,
            NULLIF(concat_ws(' ', du.first_name, du.last_name), '') AS driver_name,
            NULLIF(concat_ws(' ', ru.first_name, ru.last_name), '') AS resolved_by_name
       FROM late_confirmations lc
       JOIN booking_trips t ON t.trip_id = lc.trip_id
       LEFT JOIN booking_trip_stops s ON s.trip_stop_id = lc.trip_stop_id
       LEFT JOIN booking_destinations d ON d.destination_id = s.destination_id
       LEFT JOIN users du ON du.user_id = lc.driver_user_id
       LEFT JOIN users ru ON ru.user_id = lc.resolved_by
      WHERE lc.booking_id = $1
      ORDER BY lc.received_at DESC`,
    [bookingId],
  )
  return rows.map((r: any) => ({
    late_id:          r.late_id,
    kind:             r.kind,
    trip_stop_id:     r.trip_stop_id,
    trip_number:      r.trip_number ?? null,
    stop_number:      r.stop_number ?? null,
    address:          r.address ?? null,
    stop_status:      r.stop_status,
    driver_name:      r.driver_name,
    confirmed_at:     iso(r.confirmed_at),
    received_at:      iso(r.received_at)!,
    proof_photo_url:  r.proof_photo_url,
    latitude:         r.latitude == null ? null : Number(r.latitude),
    longitude:        r.longitude == null ? null : Number(r.longitude),
    distance_m:       r.distance_m == null ? null : Number(r.distance_m),
    override_reason:  r.override_reason,
    reasons:          r.reasons ?? [],
    reason_text:      (r.reasons ?? []).map((x: LateReason) => LATE_REASON_TEXT[x] ?? x),
    status:           r.status,
    resolved_at:      iso(r.resolved_at),
    resolved_by_name: r.resolved_by_name,
    resolution_note:  r.resolution_note,
  }))
}

/** Claim a pending flag for a decision (row lock); refuses one already decided. */
async function claimPending(bookingId: string, lateId: string) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM late_confirmations WHERE late_id = $1 AND booking_id = $2`, [lateId, bookingId])
  if (!row) throw new Error('Late confirmation not found on this booking')
  if (row.status !== 'pending') throw new Error(`Cannot decide this late confirmation: it is already ${row.status}`)
  return row
}

export async function acceptLateConfirmation(
  bookingId: string, lateId: string, note: string | null, userId: string | null,
) {
  const row     = await claimPending(bookingId, lateId)
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  const isPickup = row.kind === 'pickup'
  const trip = isPickup ? await TripModel.findById(row.trip_id) : null
  const stop = isPickup ? null : await TripModel.findStopById(row.trip_stop_id)
  if (isPickup ? !trip : !stop) throw new Error(isPickup ? 'Trip not found on this booking' : 'Drop-off not found on this booking')

  const done = isPickup
    ? trip!.status === 'in_transit' || trip!.status === 'completed'
    : stop!.status === 'delivered' || stop!.status === 'failed'
  if (done) {
    await pool.query(
      `UPDATE late_confirmations SET status = 'superseded', resolved_by = $2, resolved_at = now(),
              resolution_note = 'Already recorded another way' WHERE late_id = $1`,
      [lateId, userId])
    throw new Error(`Cannot accept: this ${isPickup ? 'loading' : 'drop-off'} is already recorded`)
  }

  // Mark it decided first so a double click can't record it twice.
  const { rowCount } = await pool.query(
    `UPDATE late_confirmations SET status = 'accepted', resolved_by = $2, resolved_at = now(), resolution_note = $3
      WHERE late_id = $1 AND status = 'pending'`,
    [lateId, userId, note?.trim() || null])
  if (!rowCount) throw new Error('Cannot accept: this late confirmation was just decided by someone else')

  const position = row.latitude != null && row.longitude != null
    ? { latitude: Number(row.latitude), longitude: Number(row.longitude), accuracy_m: row.accuracy_m == null ? null : Number(row.accuracy_m),
        override_reason: row.override_reason ?? null }
    : null
  const driverActor = { userId: row.driver_user_id, role: 'driver' }
  try {
    // The driver's own photo and position; the office's decision is the audit
    // entry below. late: done before the change of driver.
    if (isPickup) {
      await recordTripLoaded(trip!, booking, row.proof_photo_url, driverActor, true, position, row.loaded ?? null, {
        late: true, confirmedByDriverId: row.driver_id,
      })
    } else {
      await recordStopDelivered(stop!, booking, row.proof_photo_url, driverActor, position, {
        skipTransferCheck: true, confirmedByDriverId: row.driver_id, late: true,
      })
    }
  } catch (err) {
    // Put the flag back so it can be decided again.
    await pool.query(
      `UPDATE late_confirmations SET status = 'pending', resolved_by = NULL, resolved_at = NULL, resolution_note = NULL
        WHERE late_id = $1`, [lateId]).catch(() => {})
    throw err
  }

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'late_confirmation_accepted',
    description:
      `Accepted a late ${isPickup ? `loading confirmation for trip ${trip!.trip_number}` : 'drop-off confirmation'} on booking ${bookingRef(booking)}; ` +
      `recorded with the driver's photo and position${note?.trim() ? `. Note: ${note.trim()}` : ''}`,
  })
  announceRouteChanged(bookingId)
  signalLateChanged(bookingId)
  return listLateConfirmations(bookingId)
}

export async function dismissLateConfirmation(
  bookingId: string, lateId: string, reason: string, userId: string | null,
) {
  const note = reason?.trim() ?? ''
  if (note.length < 3) throw new Error('Say why this late confirmation is being dismissed')
  await claimPending(bookingId, lateId)
  const { rowCount } = await pool.query(
    `UPDATE late_confirmations SET status = 'dismissed', resolved_by = $2, resolved_at = now(), resolution_note = $3
      WHERE late_id = $1 AND status = 'pending'`,
    [lateId, userId, note])
  if (!rowCount) throw new Error('Cannot dismiss: this late confirmation was just decided by someone else')

  const booking = await BookingModel.findById(bookingId)
  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'late_confirmation_dismissed',
    description: `Dismissed a late drop-off confirmation on booking ${booking ? bookingRef(booking) : bookingId}: ${note}`,
  })
  announceRouteChanged(bookingId)
  signalLateChanged(bookingId)
  return listLateConfirmations(bookingId)
}

/**
 * What the swap dialog needs: the main driver's drop-offs not yet recorded, and
 * when each driver's phone last reached the server (a position ping or a stop
 * step) on this booking.
 */
export async function swapPreview(bookingId: string) {
  const [{ rows: open }, { rows: [crew] }] = await Promise.all([
    pool.query(
      `SELECT s.trip_stop_id, t.trip_number, t.status AS trip_status, d.sequence_order AS stop_number, d.address,
              (SELECT max(m.at) FROM stop_milestones m WHERE m.trip_stop_id = s.trip_stop_id AND m.stage = 'started') AS started_at,
              (SELECT max(m.at) FROM stop_milestones m WHERE m.trip_stop_id = s.trip_stop_id AND m.stage = 'arrived') AS arrived_at
         FROM booking_trip_stops s
         JOIN booking_trips t ON t.trip_id = s.trip_id
         LEFT JOIN booking_destinations d ON d.destination_id = s.destination_id
        WHERE t.booking_id = $1 AND t.status <> 'cancelled' AND s.status = 'pending'
        ORDER BY t.trip_number, s.sequence_order`,
      [bookingId]),
    pool.query(
      `SELECT driver_id, second_driver_id FROM deliveries WHERE booking_id = $1`, [bookingId]),
  ])

  const lastHeard = async (driverId: string | null) => {
    if (!driverId) return null
    const { rows: [r] } = await pool.query(
      `SELECT GREATEST(
                (SELECT max(recorded_at) FROM driver_location_history WHERE booking_id = $1 AND driver_id = $2),
                (SELECT max(created_at)  FROM stop_milestones        WHERE booking_id = $1 AND driver_id = $2)
              ) AS at`,
      [bookingId, driverId]).catch(async () => pool.query(
      `SELECT max(recorded_at) AS at FROM driver_location_history WHERE booking_id = $1 AND driver_id = $2`,
      [bookingId, driverId]))
    return iso(r?.at)
  }

  return {
    open_stops: open.map((r: any) => ({
      trip_stop_id: r.trip_stop_id,
      trip_number:  r.trip_number,
      trip_loaded:  r.trip_status === 'in_transit' || r.trip_status === 'completed',
      stop_number:  r.stop_number,
      address:      r.address,
      arrived_at:   iso(r.arrived_at),
      started_at:   iso(r.started_at),
    })),
    main_last_heard_at:   await lastHeard(crew?.driver_id ?? null),
    second_last_heard_at: await lastHeard(crew?.second_driver_id ?? null),
    pending_late: (await listLateConfirmations(bookingId)).filter((l) => l.status === 'pending').length,
  }
}

export interface DeliveryEvent {
  at:     string
  kind:   'pickup' | 'stop_delivered' | 'stop_failed' | 'drivers_swapped' | 'crew_replaced'
        | 'paused' | 'resumed' | 'late_received' | 'late_accepted' | 'late_dismissed' | 'late_superseded'
  title:  string
  detail: string | null
  by:     string | null
}

/** Everything that changed on the road, oldest first. */
export async function deliveryEvents(bookingId: string): Promise<DeliveryEvent[]> {
  const name = (f: string | null, l: string | null) => [f, l].filter(Boolean).join(' ') || null
  const [pickups, stops, swaps, repl, pauses, late] = await Promise.all([
    pool.query(
      `SELECT trip_number, pickup_proof_at FROM booking_trips
        WHERE booking_id = $1 AND pickup_proof_at IS NOT NULL AND status <> 'cancelled'`, [bookingId]),
    pool.query(
      `SELECT s.status, s.delivered_at, s.proof_at, s.proof_override_reason, t.trip_number, d.sequence_order AS stop_number, d.address,
              u.first_name, u.last_name
         FROM booking_trip_stops s
         JOIN booking_trips t ON t.trip_id = s.trip_id
         LEFT JOIN booking_destinations d ON d.destination_id = s.destination_id
         LEFT JOIN drivers dr ON dr.driver_id = s.confirmed_by
         LEFT JOIN users u ON u.user_id = dr.user_id
        WHERE t.booking_id = $1 AND s.status IN ('delivered','failed')`, [bookingId]),
    pool.query(
      `SELECT sw.swapped_at, sw.reason,
              ou.first_name AS of, ou.last_name AS ol, nu.first_name AS nf, nu.last_name AS nl,
              bu.first_name AS bf, bu.last_name AS bl
         FROM booking_crew_swaps sw
         LEFT JOIN drivers od ON od.driver_id = sw.old_lead_driver_id LEFT JOIN users ou ON ou.user_id = od.user_id
         LEFT JOIN drivers nd ON nd.driver_id = sw.new_lead_driver_id LEFT JOIN users nu ON nu.user_id = nd.user_id
         LEFT JOIN users bu ON bu.user_id = sw.swapped_by
        WHERE sw.booking_id = $1`, [bookingId]),
    pool.query(
      `SELECT cr.replaced_at, cr.reason_note, cr.old_vehicle_plate, cr.new_vehicle_plate,
              ou.first_name AS of, ou.last_name AS ol, nu.first_name AS nf, nu.last_name AS nl,
              bu.first_name AS bf, bu.last_name AS bl
         FROM crew_replacements cr
         LEFT JOIN drivers od ON od.driver_id = cr.old_driver_id LEFT JOIN users ou ON ou.user_id = od.user_id
         LEFT JOIN drivers nd ON nd.driver_id = cr.new_driver_id LEFT JOIN users nu ON nu.user_id = nd.user_id
         LEFT JOIN users bu ON bu.user_id = cr.replaced_by
        WHERE cr.booking_id = $1`, [bookingId]),
    pool.query(
      `SELECT p.paused_at, p.resumed_at, p.reason, p.note, p.resume_note,
              pu.first_name AS pf, pu.last_name AS pl, ru.first_name AS rf, ru.last_name AS rl
         FROM booking_pauses p
         LEFT JOIN users pu ON pu.user_id = p.paused_by
         LEFT JOIN users ru ON ru.user_id = p.resumed_by
        WHERE p.booking_id = $1`, [bookingId]),
    listLateConfirmations(bookingId),
  ])

  const out: DeliveryEvent[] = []
  const stopLabel = (r: any) => `Trip ${r.trip_number ?? '?'} · Stop ${r.stop_number ?? '?'}`

  for (const r of pickups.rows) {
    out.push({ at: iso(r.pickup_proof_at)!, kind: 'pickup', title: `Trip ${r.trip_number} loaded`, detail: null, by: null })
  }
  for (const r of stops.rows) {
    const at = iso(r.delivered_at ?? r.proof_at)
    if (!at) continue
    const office = typeof r.proof_override_reason === 'string' && /office/i.test(r.proof_override_reason)
    out.push({
      at,
      kind:   r.status === 'failed' ? 'stop_failed' : 'stop_delivered',
      title:  `${stopLabel(r)} ${r.status === 'failed' ? 'failed' : 'delivered'}`,
      detail: [r.address, r.proof_override_reason].filter(Boolean).join(' — ') || null,
      by:     office ? 'The office' : name(r.first_name, r.last_name),
    })
  }
  for (const r of swaps.rows) {
    out.push({
      at: iso(r.swapped_at)!, kind: 'drivers_swapped',
      title:  `Main driver changed: ${name(r.of, r.ol) ?? 'driver'} → ${name(r.nf, r.nl) ?? 'driver'}`,
      detail: r.reason ?? null, by: name(r.bf, r.bl),
    })
  }
  for (const r of repl.rows) {
    const parts = []
    if (r.nf || r.nl) parts.push(`driver ${name(r.of, r.ol) ?? '—'} → ${name(r.nf, r.nl)}`)
    if (r.new_vehicle_plate && r.new_vehicle_plate !== r.old_vehicle_plate) parts.push(`vehicle ${r.old_vehicle_plate ?? '—'} → ${r.new_vehicle_plate}`)
    out.push({
      at: iso(r.replaced_at)!, kind: 'crew_replaced',
      title:  `Replaced: ${parts.join(', ') || 'driver or vehicle'}`,
      detail: r.reason_note ?? null, by: name(r.bf, r.bl),
    })
  }
  for (const r of pauses.rows) {
    out.push({ at: iso(r.paused_at)!, kind: 'paused', title: 'Delivery paused', detail: [r.reason, r.note].filter(Boolean).join(' — ') || null, by: name(r.pf, r.pl) })
    if (r.resumed_at) out.push({ at: iso(r.resumed_at)!, kind: 'resumed', title: 'Delivery resumed', detail: r.resume_note ?? null, by: name(r.rf, r.rl) })
  }
  for (const l of late) {
    const label = l.kind === 'pickup' ? `Trip ${l.trip_number ?? '?'} loading` : `Trip ${l.trip_number ?? '?'} · Stop ${l.stop_number ?? '?'}`
    out.push({
      at: l.received_at, kind: 'late_received',
      title:  `Late confirmation received for ${label}`,
      detail: [l.confirmed_at ? `done ${l.confirmed_at}` : null, l.reason_text.join('; ')].filter(Boolean).join(' — ') || null,
      by:     l.driver_name,
    })
    if (l.resolved_at && l.status !== 'pending') {
      out.push({
        at: l.resolved_at,
        kind: l.status === 'accepted' ? 'late_accepted' : l.status === 'dismissed' ? 'late_dismissed' : 'late_superseded',
        title: l.status === 'accepted' ? `Late confirmation accepted (${label})`
             : l.status === 'dismissed' ? `Late confirmation dismissed (${label})`
             : `Late confirmation closed: ${label} recorded another way`,
        detail: l.resolution_note,
        by:     l.status === 'superseded' ? null : l.resolved_by_name,
      })
    }
  }

  return out.filter((e) => e.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
