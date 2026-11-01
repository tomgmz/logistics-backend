import { pool } from '../../lib/database.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { PAUSE_STAFF_ROLES } from './pause.service.js'
import type { DriverActor } from './booking.service.js'

/**
 * A breakdown the driver reports while the delivery is on the road, waiting for
 * the office. The delivery is NOT paused for them: only the Company
 * Administrator and the Operations Manager pause (and a pause tells the client),
 * so the office decides — pause it (one tap, note pre-filled), or confirm the
 * truck is moving again. Until then the booking carries
 * `breakdown_reported_at`, the office is reminded every 15 minutes
 * (breakdown.scheduler.ts), and the client gets no automatic "running late"
 * notice (delay.scheduler.ts skips it).
 *
 * The office's own "Vehicle breakdown" pause files its report with the delivery
 * already paused, so it never lands here.
 */

/** A breakdown report the trip can't continue from (unanswered counts as can't). */
export function isBlockingBreakdown(report: { incident_type?: string | null; trip_can_continue?: boolean | null }): boolean {
  return report.incident_type === 'vehicle_breakdown' && report.trip_can_continue !== true
}

/**
 * Flag the booking as waiting for the office. Only while in transit and not
 * paused; the first report wins (a second report of the same breakdown doesn't
 * restart the reminders). Best effort: never fails the report.
 */
export async function flagBreakdown(report: {
  booking_id?: string | null; report_id: string; description?: string | null
}): Promise<void> {
  if (!report.booking_id) return
  try {
    await pool.query(
      `UPDATE bookings
          SET breakdown_reported_at = COALESCE(breakdown_reported_at, now()),
              breakdown_report_id   = COALESCE(breakdown_report_id, $2),
              breakdown_note        = COALESCE(breakdown_note, $3),
              updated_at            = now()
        WHERE booking_id = $1 AND status = 'in_transit' AND paused_at IS NULL`,
      [report.booking_id, report.report_id, report.description?.slice(0, 500) ?? null],
    )
  } catch (err) {
    console.error('[breakdown] could not flag the booking', report.booking_id, err)
  }
}

/** The office decided (paused it, or the truck is moving) or the delivery ended. */
export async function clearBreakdown(bookingId: string): Promise<void> {
  await pool.query(
    `UPDATE bookings
        SET breakdown_reported_at = NULL, breakdown_report_id = NULL,
            breakdown_note = NULL, breakdown_reminded_at = NULL, updated_at = now()
      WHERE booking_id = $1 AND breakdown_reported_at IS NOT NULL`,
    [bookingId],
  )
}

/**
 * "Truck is moving again": the breakdown was fixed on the spot (or the report
 * was wrong). Stops the reminders; the vehicle stays Under Maintenance, if it
 * was put there, until the Fleet Manager inspects it.
 */
export async function dismissBreakdownService(bookingId: string, note: string, actor: DriverActor) {
  if (!actor.role || !PAUSE_STAFF_ROLES.includes(actor.role)) {
    throw new Error('You are not allowed to handle this breakdown')
  }
  const text = note.trim()
  if (text.length < 3) throw new Error('Say what happened to the breakdown')

  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  if (!(booking as { breakdown_reported_at?: string | null }).breakdown_reported_at) return booking

  await clearBreakdown(bookingId)
  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'breakdown_dismissed',
    description: `Breakdown on booking ${bookingRef(booking)} handled without a pause (truck moving again): ${text}`,
  })
  return (await BookingModel.findById(bookingId)) ?? booking
}
