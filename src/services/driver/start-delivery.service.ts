import { withBookingRowLock, crewSeatFor } from '../../lib/booking-row-lock.js'
import { isBeforeScheduledDay } from '../../lib/ph-date.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { assertBookingVehicleInService } from '../admin/fleet-availability.service.js'
import { notifyStage } from '../notification/notification.service.js'
import type { DriverActor } from '../client/booking.service.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'

/**
 * The booking leaves 'assigned' for 'in_transit', under the booking row lock.
 *
 * This is the moment the crew is settled: once it commits, staff can no longer
 * re-assign the booking (assignBookingService refuses anything past 'assigned'),
 * and if the office re-crewed it first, the check below sees the new crew and
 * refuses the old driver. Both the driver's Start Navigation and every pickup
 * confirmation go through it, so a pickup made offline — whose start never
 * reached us — still settles the crew the same way.
 *
 * Returns whether this call did the move (false when it was already moving).
 * Throws the same "not assigned" sentence the other trip writes use, which the
 * controllers turn into a 403 and the phone's queue drops.
 */
export async function claimDeliveryStart(bookingId: string, actor: DriverActor): Promise<boolean> {
  const now = new Date().toISOString()
  return withBookingRowLock(bookingId, async (client, booking) => {
    if (actor.role !== 'admin') {
      const seat = actor.userId ? await crewSeatFor(client, bookingId, actor.userId) : null
      if (!seat) throw new Error('You are not assigned to this booking')
      if (seat !== 'lead') {
        throw new Error('Only the main driver can update this delivery in the app. You are the second driver on this booking.')
      }
    }

    if (booking.status === 'in_transit') return false
    if (booking.status !== 'assigned') {
      throw new Error(`Cannot start a delivery that is '${booking.status}'`)
    }

    await client.query(
      `UPDATE bookings SET status = 'in_transit', updated_at = $2 WHERE booking_id = $1`,
      [bookingId, now],
    )
    // The delivery record moves with it — it is what operations reads to see who
    // is on the road. pickup_time keeps meaning "set off", as settleDelivery has it.
    await client.query(
      `UPDATE deliveries
          SET status = 'in_transit', pickup_time = COALESCE(pickup_time, $2), updated_at = $2
        WHERE booking_id = $1`,
      [bookingId, now],
    )
    return true
  })
}

/**
 * The driver tapped Start (or Resume) Navigation. The booking is in transit from
 * here, not from the pickup photo: the truck is on the road to the pickup, the
 * client can watch it, and its crew can no longer be swapped from the web.
 *
 * Same gates as a pickup that would start the job: the vehicle must still be in
 * service, and a start before the scheduled day needs the driver's explicit
 * "start early". Idempotent — Resume and the offline queue re-send it.
 */
export async function driverStartDeliveryService(
  bookingId: string,
  actor: DriverActor,
  earlyStart = false,
): Promise<{ booking: BookingWithRelations; started: boolean }> {
  const before = await BookingModel.findById(bookingId)
  if (!before) throw new Error(`Booking with ID ${bookingId} not found`)

  const early = isBeforeScheduledDay(before.schedule_date)
  if (before.status === 'assigned') {
    await assertBookingVehicleInService(bookingId)
    if (early && !earlyStart) {
      throw new Error(
        `Cannot start before the scheduled day — this booking is scheduled for ${before.schedule_date}.`,
      )
    }
  }

  const started = await claimDeliveryStart(bookingId, actor)
  const booking = (await BookingModel.findById(bookingId)) ?? before

  if (started) {
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      early ? 'driver_started_delivery_early' : 'driver_started_delivery',
      description: early
        ? `Driver started booking ${bookingRef(booking)} EARLY — scheduled for ${before.schedule_date}; booking is in transit`
        : `Driver started booking ${bookingRef(booking)}; booking is in transit`,
    })
    void notifyStage('delivery_started', booking)
  }

  return { booking, started }
}
