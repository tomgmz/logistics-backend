import { pool } from '../../lib/database.js'
import { distanceInMetres, STOP_PROOF_RADIUS_M, type StopProofPosition } from '../../lib/stop-geofence.js'
import { fromDeviceClock } from '../../lib/device-clock.js'

/**
 * A drop-off confirmed on a phone that is no longer the main driver's.
 *
 * The office swapped the main and second driver (or replaced the driver) while
 * the old main driver's phone still held a confirmation in its offline queue.
 * It arrives late, from someone who is no longer the main driver. Refusing it
 * loses a delivery that really happened; accepting anything lets a driver who
 * was taken off confirm stops they never reached.
 *
 * So a late confirmation is judged by WHEN it was done and the EVIDENCE it
 * carries, never by when it arrived (industry practice: event time, not
 * arrival time). It is applied automatically only when all of these hold:
 *
 *   1. it carries the time it was done (the app sends confirmed_at), and at
 *      that time this driver WAS the main driver (booking_crew_swaps +
 *      crew_replacements);
 *   2. it has its proof photo;
 *   3. its position is within 100 m of the drop-off, with no override;
 *   4. the truck's GPS trail does not contradict it: if the server holds pings
 *      within 10 minutes of that time, at least one is within 500 m of the
 *      drop-off. No pings at all (the phone was offline, which is why the
 *      confirmation was late) is not a contradiction.
 *
 * Anything else is kept in late_confirmations for the office to Accept or
 * Dismiss, and the phone is told it was received, so its queue moves on.
 * Tapping Start gives no right to confirm: it proves nothing about the road.
 */

export const TRAIL_WINDOW_MS = 10 * 60_000
export const TRAIL_RADIUS_M  = 500

export type LateReason =
  | 'no_time'            // older app: no confirmed_at, so "when" is unknown
  | 'after_change'       // done after the swap / replacement took effect
  | 'not_main_then'      // this driver was the second driver at that time
  | 'no_photo'
  | 'no_position'
  | 'too_far'            // over 100 m, or the driver overrode the gate
  | 'trail_disagrees'    // the truck's pings put it elsewhere at that time

export const LATE_REASON_TEXT: Record<LateReason, string> = {
  no_time:         'the app did not say when it was done (older app version)',
  after_change:    'it was done after the office changed the main driver',
  not_main_then:   'this driver was the second driver at that time',
  no_photo:        'no proof photo',
  no_position:     'no position from the phone',
  too_far:         'more than 100 m from the drop-off',
  trail_disagrees: "the truck's GPS trail puts it elsewhere at that time",
}

/** Who held the main-driver seat at `atMs`. Null when nobody did (before assignment). */
export async function leadDriverAt(bookingId: string, atMs: number): Promise<string | null> {
  const { rows: events } = await pool.query<{ at: Date; old_lead: string | null }>(
    `SELECT swapped_at AS at, old_lead_driver_id AS old_lead
       FROM booking_crew_swaps WHERE booking_id = $1 AND swapped_at > $2
     UNION ALL
     SELECT replaced_at AS at, old_driver_id AS old_lead
       FROM crew_replacements
      WHERE booking_id = $1 AND replaced_at > $2
        AND new_driver_id IS NOT NULL AND new_driver_id IS DISTINCT FROM old_driver_id
     ORDER BY at ASC
     LIMIT 1`,
    [bookingId, new Date(atMs).toISOString()],
  )
  if (events[0]) return events[0].old_lead
  const { rows: [d] } = await pool.query<{ driver_id: string | null }>(
    `SELECT driver_id FROM deliveries WHERE booking_id = $1`, [bookingId])
  return d?.driver_id ?? null
}

/** Whether this driver was ever on the booking and taken off by a replacement. */
export async function wasReplacedOff(bookingId: string, driverId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM crew_replacements
      WHERE booking_id = $1 AND (old_driver_id = $2 OR old_second_driver_id = $2) LIMIT 1`,
    [bookingId, driverId],
  )
  return rows.length > 0
}

/** The phone's confirmed_at moved onto the server clock, never in the future. Null when absent or unreadable. */
export function confirmedAtMs(raw: string | null | undefined): number | null {
  const at = fromDeviceClock(typeof raw === 'string' ? raw : null)
  if (at == null) return null
  return Math.min(at, Date.now())
}

export interface LateEvidence {
  bookingId:     string
  driverId:      string
  stop:          { latitude: number; longitude: number } | null
  proofPhotoUrl: string | null
  position:      StopProofPosition | null | undefined
  atMs:          number | null
}

export interface LateVerdict {
  ok:         boolean
  reasons:    LateReason[]
  distance_m: number | null
}

/** The four checks above. Every failing reason is listed, for the office. */
export async function judgeLateConfirmation(e: LateEvidence): Promise<LateVerdict> {
  const reasons: LateReason[] = []

  if (e.atMs == null) {
    reasons.push('no_time')
  } else {
    const lead = await leadDriverAt(e.bookingId, e.atMs)
    if (lead !== e.driverId) {
      // Distinguish "after the change" from "never the main driver then".
      const { rows: [cur] } = await pool.query<{ driver_id: string | null }>(
        `SELECT driver_id FROM deliveries WHERE booking_id = $1`, [e.bookingId])
      const everLead = await pool.query(
        `SELECT 1 FROM booking_crew_swaps WHERE booking_id = $1 AND old_lead_driver_id = $2
         UNION ALL SELECT 1 FROM crew_replacements WHERE booking_id = $1 AND old_driver_id = $2 LIMIT 1`,
        [e.bookingId, e.driverId])
      reasons.push(everLead.rows.length > 0 && cur?.driver_id !== e.driverId ? 'after_change' : 'not_main_then')
    }
  }

  if (!e.proofPhotoUrl) reasons.push('no_photo')

  const pos = e.position
  const hasPos = !!pos && Number.isFinite(pos.latitude) && Number.isFinite(pos.longitude)
  let distance: number | null = null
  if (!hasPos) {
    reasons.push('no_position')
  } else if (e.stop) {
    distance = Math.round(distanceInMetres(e.stop, pos!))
    if (distance > STOP_PROOF_RADIUS_M || pos!.override_reason?.trim()) reasons.push('too_far')
  } else if (pos!.override_reason?.trim()) {
    reasons.push('too_far')
  }

  if (e.atMs != null && e.stop) {
    const { rows } = await pool.query<{ latitude: string; longitude: string }>(
      `SELECT latitude, longitude FROM driver_location_history
        WHERE booking_id = $1 AND recorded_at BETWEEN $2 AND $3`,
      [e.bookingId, new Date(e.atMs - TRAIL_WINDOW_MS).toISOString(), new Date(e.atMs + TRAIL_WINDOW_MS).toISOString()],
    )
    if (rows.length > 0) {
      const near = rows.some((r) => distanceInMetres(e.stop!, { latitude: Number(r.latitude), longitude: Number(r.longitude) }) <= TRAIL_RADIUS_M)
      if (!near) reasons.push('trail_disagrees')
    }
  }

  return { ok: reasons.length === 0, reasons, distance_m: distance }
}

/** Keep a confirmation that failed the check, for the office. One open flag per step and driver. */
export async function saveLateConfirmation(input: {
  kind: 'pickup' | 'dropoff'
  bookingId: string; tripId: string; tripStopId: string | null; driverId: string; driverUserId: string | null
  atMs: number | null; proofPhotoUrl: string | null; position: StopProofPosition | null | undefined
  verdict: LateVerdict
  loaded?: unknown
}): Promise<{ late_id: string; created: boolean }> {
  // Already flagged and still open (the phone re-sent it): note it arrived again.
  const findOpen = async () => {
    const { rows: [open] } = await pool.query<{ late_id: string }>(
      input.kind === 'pickup'
        ? `SELECT late_id FROM late_confirmations WHERE kind = 'pickup' AND trip_id = $1 AND driver_id = $2 AND status = 'pending'`
        : `SELECT late_id FROM late_confirmations WHERE kind = 'dropoff' AND trip_stop_id = $1 AND driver_id = $2 AND status = 'pending'`,
      [input.kind === 'pickup' ? input.tripId : input.tripStopId, input.driverId])
    return open ?? null
  }
  const existing = await findOpen()
  if (existing) {
    await pool.query(`UPDATE late_confirmations SET received_at = now() WHERE late_id = $1`, [existing.late_id])
    return { late_id: existing.late_id, created: false }
  }

  const p = input.position
  try {
    const { rows: [row] } = await pool.query<{ late_id: string }>(
      `INSERT INTO late_confirmations
         (booking_id, kind, trip_id, trip_stop_id, loaded, driver_id, driver_user_id, confirmed_at, proof_photo_url,
          latitude, longitude, accuracy_m, distance_m, override_reason, reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING late_id`,
      [
        input.bookingId, input.kind, input.tripId, input.tripStopId,
        input.loaded == null ? null : JSON.stringify(input.loaded),
        input.driverId, input.driverUserId,
        input.atMs == null ? null : new Date(input.atMs).toISOString(),
        input.proofPhotoUrl,
        p && Number.isFinite(p.latitude) ? p.latitude : null,
        p && Number.isFinite(p.longitude) ? p.longitude : null,
        p?.accuracy_m ?? null,
        input.verdict.distance_m,
        p?.override_reason?.trim() || null,
        input.verdict.reasons,
      ],
    )
    return { late_id: row.late_id, created: true }
  } catch (err: any) {
    // Two sends at the same moment: the unique index let one in.
    if (err?.code === '23505') {
      const again = await findOpen()
      if (again) return { late_id: again.late_id, created: false }
    }
    throw err
  }
}

/** A step got recorded another way: its open flags are no longer a decision. */
export async function supersedeLateConfirmations(ref: { tripStopId?: string; tripId?: string }): Promise<void> {
  const byStop = !!ref.tripStopId
  await pool.query(
    `UPDATE late_confirmations SET status = 'superseded', resolved_at = now(),
            resolution_note = COALESCE(resolution_note, $2)
      WHERE ${byStop ? `kind = 'dropoff' AND trip_stop_id = $1` : `kind = 'pickup' AND trip_id = $1`} AND status = 'pending'`,
    [byStop ? ref.tripStopId : ref.tripId, byStop ? 'The drop-off was recorded another way' : 'The loading was recorded another way'],
  ).catch((err) => console.error('[late-confirmations] supersede failed', ref, err))
}
