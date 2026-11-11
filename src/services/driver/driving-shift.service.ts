import type { PoolClient } from 'pg'
import { pool } from '../../lib/database.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { broadcast } from '../../lib/realtime.js'
import { fromDeviceClock, hasDeviceClock } from '../../lib/device-clock.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from '../notification/notification.service.js'
import { driverSeatOnBooking, type DriverActor } from '../client/booking.service.js'
import { driverIdOf } from './crew-actor.js'

/**
 * Who is at the wheel. A long run carries a second driver precisely so the two
 * can swap, and the phone in the truck (the main driver's) says nothing about
 * which of them is driving. Fines from no-contact apprehension, an accident, or
 * rest hours all hang on that, so each stretch at the wheel is recorded:
 *
 *   - Start Navigation opens the main driver's shift (`startShiftIfNone`);
 *   - "I'm taking the wheel" in the app (either crew member) closes the open
 *     shift and opens one for whoever tapped it (`driverTakeWheelService`);
 *   - the office can record it too, and swaps the crew roles when the main
 *     driver's phone is dead (`staffSwapCrewRolesService`);
 *   - the vehicle's confirmed return closes the last shift (`closeShifts`).
 *
 * The record is the crew's word, like every tap: nothing on a phone can see who
 * holds the wheel. It is honest enough to ask "who was driving at 14:05?".
 */

const CLOCK_FLAG_MS = 60_000

export interface DrivingShift {
  shift_id:   string
  driver_id:  string
  driver_name: string | null
  started_at: string
  ended_at:   string | null
  source:     'start' | 'switch' | 'staff'
  clock_adjusted: boolean
}

async function announce(bookingId: string): Promise<void> {
  await broadcast(`route:booking:${bookingId}`, 'route_changed', { booking_id: bookingId, kind: 'driving' }).catch(() => {})
}

/** Close the open shift at `at` and open one for `driverId` — in one transaction. */
async function switchTo(
  client: PoolClient,
  bookingId: string,
  driverId: string,
  at: string,
  source: 'start' | 'switch' | 'staff',
  recordedBy: string | null,
  extra: { latitude?: number | null; longitude?: number | null; clockAdjusted?: boolean } = {},
): Promise<boolean> {
  const { rows: [open] } = await client.query(
    `SELECT shift_id, driver_id, started_at FROM booking_driving_shifts
      WHERE booking_id = $1 AND ended_at IS NULL FOR UPDATE`,
    [bookingId],
  )
  if (open?.driver_id === driverId) return false
  // Never end a shift before it began (a queued tap older than the last switch).
  const atMs = Math.max(Date.parse(at), open ? new Date(open.started_at).getTime() : 0)
  const when = new Date(atMs).toISOString()
  if (open) {
    await client.query(`UPDATE booking_driving_shifts SET ended_at = $2 WHERE shift_id = $1`, [open.shift_id, when])
  }
  await client.query(
    `INSERT INTO booking_driving_shifts (booking_id, driver_id, started_at, source, recorded_by, latitude, longitude, clock_adjusted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [bookingId, driverId, when, source, recordedBy, extra.latitude ?? null, extra.longitude ?? null, !!extra.clockAdjusted],
  )
  return true
}

/** Start Navigation: the main driver is at the wheel, unless a shift is already open. */
export async function startShiftIfNone(client: PoolClient, bookingId: string, at: string, recordedBy: string | null): Promise<void> {
  await client.query(
    `INSERT INTO booking_driving_shifts (booking_id, driver_id, started_at, source, recorded_by)
     SELECT $1, da.driver_id, $2, 'start', $3
       FROM driver_assignments da
      WHERE da.booking_id = $1 AND COALESCE(da.crew_role, 'lead') <> 'second'
        AND NOT EXISTS (SELECT 1 FROM booking_driving_shifts s WHERE s.booking_id = $1 AND s.ended_at IS NULL)
      LIMIT 1`,
    [bookingId, at, recordedBy],
  )
}

/** After a crew replacement: the shifts so far end, and the new main driver is at the wheel. */
export async function restartWithLead(bookingId: string, recordedBy: string | null): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const now = new Date().toISOString()
    await client.query(
      `UPDATE booking_driving_shifts SET ended_at = GREATEST($2::timestamptz, started_at)
        WHERE booking_id = $1 AND ended_at IS NULL`, [bookingId, now])
    await startShiftIfNone(client, bookingId, now, recordedBy)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** The truck is back in the lot (or the delivery ended): nobody is driving it for this booking. */
export async function closeShifts(bookingId: string, at = new Date().toISOString()): Promise<void> {
  await pool.query(
    `UPDATE booking_driving_shifts SET ended_at = GREATEST($2::timestamptz, started_at)
      WHERE booking_id = $1 AND ended_at IS NULL`,
    [bookingId, at],
  )
}

/**
 * A crew member says they are driving now. Either the main or the second driver,
 * while the delivery is in transit. Sent through the app's offline queue with
 * the phone's time, corrected like every other tap (lib/device-clock).
 */
export async function driverTakeWheelService(
  bookingId: string,
  body: { at?: string | null; latitude?: number | null; longitude?: number | null },
  actor: DriverActor,
) {
  const { booking } = await driverSeatOnBooking(bookingId, actor)
  // On the road: in transit, or delivered and still driving back to the lot.
  const onRoad = booking.status === 'in_transit'
    || ((booking.status === 'delivered' || booking.status === 'completed') && !(booking as any).fleet_return_at)
  if (!onRoad) {
    throw new Error('Cannot record who is driving: the truck is not on the road for this booking')
  }
  const driverId = await driverIdOf(actor)
  if (!driverId) throw new Error('You are not assigned to this booking')

  const received = Date.now()
  const device   = fromDeviceClock(typeof body.at === 'string' ? body.at : null)
  let at = device != null && hasDeviceClock() ? device : received
  if (at > received) at = received
  const clockAdjusted = device != null && Math.abs(at - device) > CLOCK_FLAG_MS

  const client = await pool.connect()
  let switched = false
  try {
    await client.query('BEGIN')
    switched = await switchTo(client, bookingId, driverId, new Date(at).toISOString(), 'switch', actor.userId ?? null, {
      latitude: body.latitude, longitude: body.longitude, clockAdjusted,
    })
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  if (switched) {
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      'driver_took_wheel',
      description: `A driver took the wheel on booking ${bookingRef(booking)}`,
    })
    void announce(bookingId)
  }
  return { switched, shifts: await listShifts(bookingId) }
}

/** Every stretch at the wheel on a booking, oldest first, with the driver's name. */
export async function listShifts(bookingId: string): Promise<DrivingShift[]> {
  const { rows } = await pool.query(
    `SELECT s.shift_id, s.driver_id::text, s.started_at, s.ended_at, s.source, s.clock_adjusted,
            NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS driver_name
       FROM booking_driving_shifts s
       JOIN drivers d ON d.driver_id = s.driver_id
       LEFT JOIN users u ON u.user_id = d.user_id
      WHERE s.booking_id = $1
      ORDER BY s.started_at`,
    [bookingId],
  )
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v))
  return rows.map((r: any) => ({ ...r, started_at: iso(r.started_at)!, ended_at: iso(r.ended_at) }))
}

/**
 * The office swaps the main and second driver while on the road: the main
 * driver's phone is dead or lost, so the second driver's phone has to confirm
 * stops and report the truck's position from here on. The new main driver is
 * recorded at the wheel. A reason is required; both drivers are told.
 *
 * What the old main driver's phone still has queued (a stop it confirmed
 * offline) is judged by when it was done (late-confirmation.service): accepted
 * when it passes the evidence check, otherwise kept for the office to decide.
 */
export async function staffSwapCrewRolesService(bookingId: string, reason: string, staffUserId: string | null) {
  const note = reason.trim()
  if (note.length < 3) throw new Error('Say why the main and second driver are being swapped')

  const client = await pool.connect()
  let leadUser: string | null = null
  try {
    await client.query('BEGIN')
    const { rows: [b] } = await client.query(
      `SELECT status FROM bookings WHERE booking_id = $1 FOR UPDATE`, [bookingId])
    if (!b) throw new Error(`Booking with ID ${bookingId} not found`)
    if (b.status !== 'in_transit') throw new Error('The main and second driver can only be swapped while the delivery is in transit')

    const { rows: [del] } = await client.query(
      `SELECT delivery_id, driver_id, second_driver_id FROM deliveries WHERE booking_id = $1 FOR UPDATE`, [bookingId])
    if (!del?.driver_id || !del?.second_driver_id) throw new Error('This delivery has no second driver to swap with')

    await client.query(
      `UPDATE deliveries SET driver_id = $2, second_driver_id = $3, updated_at = now() WHERE delivery_id = $1`,
      [del.delivery_id, del.second_driver_id, del.driver_id])
    await client.query(
      `UPDATE driver_assignments
          SET crew_role = CASE WHEN driver_id = $2 THEN 'second' ELSE 'lead' END
        WHERE booking_id = $1 AND driver_id IN ($2, $3)`,
      [bookingId, del.driver_id, del.second_driver_id])
    // The swap's own record: late confirmations from the old main driver's
    // phone are judged against this time (late-confirmation.service).
    await client.query(
      `INSERT INTO booking_crew_swaps (booking_id, old_lead_driver_id, new_lead_driver_id, swapped_by, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [bookingId, del.driver_id, del.second_driver_id, staffUserId, note])
    await switchTo(client, bookingId, del.second_driver_id, new Date().toISOString(), 'staff', staffUserId)

    const { rows: [u] } = await client.query(`SELECT user_id FROM drivers WHERE driver_id = $1`, [del.second_driver_id])
    leadUser = u?.user_id ?? null
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  const booking = await BookingModel.findById(bookingId)
  logEvent({
    user_id:     staffUserId,
    log_type:    'booking',
    action:      'drivers_swapped',
    description: `Main and second driver swapped on booking ${booking ? bookingRef(booking) : bookingId}: ${note}`,
  })
  if (booking) void notifyStage('crew_roles_swapped', booking, { reason: note })
  void announce(bookingId)
  return { new_lead_user_id: leadUser, shifts: await listShifts(bookingId) }
}
