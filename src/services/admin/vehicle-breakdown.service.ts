import { pool } from '../../lib/database.js'
import { logEvent } from '../../lib/log-event.js'
import { liveBookingForTruck } from '../../lib/driver-reservation.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from '../notification/notification.service.js'

/**
 * A vehicle that breaks down on a delivery goes Under Maintenance by itself.
 *
 * Triggered by a vehicle_breakdown driver report whose trip can't continue —
 * the one the office files when it pauses a delivery for a breakdown, or the
 * driver's own. A report that says the trip CAN continue (a flat fixed on the
 * spot) leaves the vehicle alone; the Fleet Manager is told about the report
 * as for any vehicle incident and decides.
 *
 * Under Maintenance rather than a new status, because every gate already keys
 * off it: the vehicle can't be assigned, the hold survives the booking ending,
 * and only a passing inspection (or the Fleet Manager) puts it back. The
 * maintenance_* columns say why, for Vehicle Management; a DB trigger clears
 * them whenever the vehicle leaves Under Maintenance.
 *
 * Idempotent and best effort: an Inactive or archived vehicle is left as it
 * is, one already Under Maintenance only gets the reason filled in, and a
 * failure never fails the report.
 */
export async function holdVehicleForBreakdown(input: {
  truckId:   string
  bookingId: string | null
  reportId:  string
  note:      string | null
  actorId:   string | null
}): Promise<void> {
  try {
    const { rows: [t] } = await pool.query(
      `UPDATE trucks
          SET status                 = 'under_maintenance',
              maintenance_reason     = 'breakdown',
              maintenance_since      = COALESCE(CASE WHEN status = 'under_maintenance' THEN maintenance_since END, now()),
              maintenance_booking_id = $2,
              maintenance_report_id  = $3,
              maintenance_note       = $4,
              updated_at             = now()
        WHERE truck_id = $1 AND status IN ('available', 'in_use', 'recheck_due', 'under_maintenance')
        RETURNING plate_number`,
      [input.truckId, input.bookingId, input.reportId, input.note?.slice(0, 500) ?? null],
    )
    if (!t) return

    const booking = await liveBookingForTruck(input.truckId)
    logEvent({
      user_id:     input.actorId,
      log_type:    'vehicle_activity',
      action:      'vehicle_breakdown_hold',
      description: `Vehicle ${t.plate_number} put Under Maintenance after a breakdown` +
        (booking ? ` on booking ${booking.reference_number ?? booking.booking_id}` : '') +
        (input.note ? `: ${input.note}` : ''),
    })

    // Operations + the Company Administrator: the booking needs a replacement
    // vehicle or has to wait for the repair (same notice as a manual pull).
    if (booking) {
      const full = await BookingModel.findById(booking.booking_id)
      if (full) {
        void notifyStage('vehicle_out_of_service', full, {
          vehicleLabel: t.plate_number,
          statusLabel:  'Under Maintenance after a breakdown',
          onTheRoad:    booking.status !== 'assigned',
        })
      }
    }
  } catch (err) {
    console.error('[breakdown] could not put the vehicle on hold', input.truckId, err)
  }
}

/** Should this report put the vehicle on hold? A breakdown the trip can't go on from (unanswered counts as can't). */
export function isBreakdownHold(report: { incident_type?: string | null; trip_can_continue?: boolean | null; truck_id?: string | null }): boolean {
  return report.incident_type === 'vehicle_breakdown' && report.trip_can_continue !== true && !!report.truck_id
}
