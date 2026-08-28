import { BookingModel } from '../../models/client/booking.model.js'
import {
  CreateBookingInput,
  UpdateBookingInput,
  UpdateDestinationInput,
  BookingWithRelations,
  BookingDestination,
  BookingCargoItem,
  GmReviewInput,
} from '../../types/client/booking.types.js'
import { optimizeDestinationsService } from '../maps/routeOptimization.service.js'
import { MAX_DESTINATIONS_PER_BOOKING } from '../../lib/booking-limits.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { isBeforeScheduledDay, phDay } from '../../lib/ph-date.js'
import { notifyStage, hasGmApprovers } from '../notification/notification.service.js'
import { crewOnBooking, releaseCrew } from '../admin/fleet-availability.service.js'
import {
  assertStopProximity,
  stopCoordinates,
  type GeofenceOutcome,
  type StopProofPosition,
} from '../../lib/stop-geofence.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Sunday. The fleet does not run, and the driver calendar cannot tick it. */
const REST_WEEKDAY = 0

/**
 * How far ahead a client has to book: tomorrow at the earliest, a year out at
 * the latest.
 *
 * Compared in Philippine calendar days, matching the `date` column — the
 * server's own timezone must not decide what "tomorrow" means to a client in
 * Manila.
 */
function validateScheduleDate(scheduleDate: string): void {
  const scheduled = scheduleDate.slice(0, 10)

  // Sunday is the fleet's rest day: the driver calendar cannot express it, so no
  // driver can ever tick one, and a Sunday booking would be uncrewable — it
  // would sit in the queue with an empty driver list and no way to explain why.
  // Refuse it at the door instead.
  if (new Date(`${scheduled}T00:00:00Z`).getUTCDay() === REST_WEEKDAY) {
    throw new Error('Deliveries are not scheduled on Sundays — please pick another day')
  }

  const earliest = phDay(Date.now() + DAY_MS)
  if (scheduled < earliest) {
    throw new Error(`Booking must be scheduled at least a day ahead (earliest: ${earliest})`)
  }

  const oneYearOut = new Date()
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1)
  if (scheduled > phDay(oneYearOut)) {
    throw new Error('Booking cannot be scheduled more than 1 year in advance')
  }
}

const NON_DELETABLE_STATUSES = ['approved', 'assigned', 'in_transit', 'completed']

export interface PaginatedBookingsMeta {
  total:        number
  page:         number
  limit:        number
  totalPages:   number
  statusCounts: Record<string, number>
}

export async function getAllBookingsPaginatedService(params: {
  page:    number
  limit:   number
  status?: string | null
  search?: string | null
}): Promise<{ data: BookingWithRelations[]; meta: PaginatedBookingsMeta }> {
  const page  = Math.max(1, params.page)
  const limit = Math.min(Math.max(1, params.limit), 100)

  const [{ rows, total }, statusCounts] = await Promise.all([
    BookingModel.findAllPaginated({ page, limit, status: params.status, search: params.search }),
    BookingModel.countByStatus(),
  ])

  return {
    data: rows,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusCounts,
    },
  }
}


export async function getAllBookingsService(): Promise<BookingWithRelations[]> {
  return await BookingModel.findAll() ?? []
}

export async function getBookingByIdService(bookingId: string): Promise<BookingWithRelations> {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  return booking
}

export async function getBookingsByClientService(clientId: string): Promise<BookingWithRelations[]> {
  return await BookingModel.findByClientId(clientId) ?? []
}

export async function getBookingsByDriverService(driverId: string): Promise<BookingWithRelations[]> {
  return await BookingModel.findByDriverId(driverId) ?? []
}

export async function createBookingService(
  input: CreateBookingInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  if (!input.destinations || input.destinations.length === 0) {
    throw new Error('At least one destination is required')
  }
  if (input.destinations.length > MAX_DESTINATIONS_PER_BOOKING) {
    throw new Error(`A booking can have at most ${MAX_DESTINATIONS_PER_BOOKING} drop-offs`)
  }

  validateScheduleDate(input.schedule_date)

  const orders = input.destinations.map((d) => d.sequence_order)
  if (new Set(orders).size !== orders.length) {
    throw new Error('sequence_order must be unique per destination')
  }

  // Route optimisation — only when all coords are present
  const allHaveCoords   = input.destinations.every((d) => d.latitude != null && d.longitude != null)
  const originHasCoords = input.origin_latitude != null && input.origin_longitude != null

  if (allHaveCoords && originHasCoords) {
    try {
      const optimizedOrder = await optimizeDestinationsService(
        { latitude: input.origin_latitude!, longitude: input.origin_longitude! },
        input.destinations as Array<{ address: string; latitude: number; longitude: number; sequence_order: number }>,
        input.schedule_date,
        input.call_time,
      )
      input.destinations = input.destinations.map((dest) => {
        const match = optimizedOrder.find((o) => o.address === dest.address)
        return match ? { ...dest, sequence_order: match.optimized_sequence_order } : dest
      })
    } catch (err) {
      console.warn('Pre-creation route optimization failed, using original order:', err)
    }
  }

  const booking = await BookingModel.create(input)
  if (!booking) throw new Error('Failed to create booking')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_created',
    description: `Booking ${bookingRef(booking)} created for client ${booking.client_id}`,

  })

  // Stage 1: straight to the general manager (or an appointed GM proxy) for
  // approval. If nobody can act on that stage, clear it and hand the booking to
  // operations so a new booking is never stranded.
  void routeNewBookingToGm(booking, userId)

  return booking
}

/**
 * Send a freshly created booking into the approval chain. Normally that means
 * notifying the GM stage; with nobody staffed to approve (no general manager and
 * no proxy) the stage is auto-cleared and the booking goes straight to ops.
 */
async function routeNewBookingToGm(
  booking: BookingWithRelations,
  userId?: string | null,
): Promise<void> {
  try {
    if (await hasGmApprovers()) {
      await notifyStage('gm_pending', booking)
      return
    }

    await BookingModel.updateGmStatus(booking.booking_id, { gm_status: 'approved' })
    const advanced = await BookingModel.updateStatus(booking.booking_id, 'approved')
    logEvent({
      user_id:     userId,
      log_type:    'booking',
      action:      'gm_auto_approved',
      description: `Booking ${bookingRef(booking)} GM stage auto-cleared (no general manager or proxy staffed)`,
    })
    await notifyStage('ops_pending', advanced ?? booking)
  } catch (err) {
    console.error('[booking] failed to route new booking to the GM stage', booking.booking_id, err)
  }
}

export async function updateBookingService(
  bookingId: string,
  input: UpdateBookingInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (input.schedule_date) {
    validateScheduleDate(input.schedule_date)
  }

  const booking = await BookingModel.update(bookingId, input)
  if (!booking) throw new Error('Failed to update booking')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_updated',
    description: `Booking ${bookingRef(booking)} updated`,

  })

  return booking
}

export async function updateBookingStatusService(
  bookingId: string,
  status: string,
  userId?: string | null,
  ip?: string | null,
  // The administrator's remarks when turning a booking down. Stored on the
  // booking and sent to the client with the rejection notification.
  rejectionReason?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  const statusOrder  = ['pending', 'approved', 'assigned', 'in_transit', 'completed', 'cancelled']
  const currentIndex = statusOrder.indexOf(existing.status)
  const newIndex     = statusOrder.indexOf(status)

  if (newIndex === currentIndex) return existing

  if (newIndex < currentIndex && status !== 'cancelled') {
    throw new Error(`Cannot change status from '${existing.status}' back to '${status}'`)
  }

  // A cancellation is a decision with an author: record who made it and why, so
  // the client can be told the reason and the record shows it was the
  // administrator — not the general manager, who may never have seen it.
  const booking = status === 'cancelled'
    ? await BookingModel.cancelBooking(bookingId, { reason: rejectionReason, cancelledBy: userId })
    : await BookingModel.updateStatus(bookingId, status)
  if (!booking) throw new Error('Failed to update booking status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `booking_${status}`,
    description: status === 'cancelled' && rejectionReason
      ? `Booking ${bookingRef(booking)} rejected by the administrator: ${rejectionReason}`
      : `Booking ${bookingRef(booking)} marked as ${status}`,

  })

  // Approving the booking via the top-level status control hands it to
  // operations: clear a still-pending GM stage so the record is consistent, then
  // notify the operations manager to select a vehicle and driver.
  if (status === 'approved' && existing.status !== 'approved' && existing.ops_status !== 'assigned') {
    if (existing.gm_status === 'pending') {
      await BookingModel.updateGmStatus(bookingId, { gm_status: 'approved' })
    }
    const advanced = await BookingModel.findById(bookingId)
    logEvent({
      user_id:     userId,
      log_type:    'booking',
      action:      'booking_approved_to_ops',
      description: `Booking ${bookingRef(advanced ?? booking)} approved; routed to operations`,
    })
    void notifyStage('ops_pending', advanced ?? booking)
  }

  // The delivery is over: settle the delivery record and hand the driver and
  // vehicle back to the pool.
  if (status === 'completed') {
    await BookingModel.settleDelivery(bookingId, 'delivered')
    void releaseBookingCrew(bookingId)
  } else if (status === 'cancelled') {
    await BookingModel.settleDelivery(bookingId, 'failed')
    void releaseBookingCrew(bookingId)

    // Tell the client their booking was turned down, and why. Only for a booking
    // that hadn't already been rejected upstream, so the client isn't told twice
    // about the same decision.
    if (existing.status !== 'cancelled' && existing.gm_status !== 'rejected') {
      void notifyStage('rejected_admin', booking, { reason: rejectionReason })
    }
  }

  return booking
}

/**
 * Return a finished booking's driver and vehicle to their resting states. Best
 * effort — a booking that never got an assignment simply has no crew to release.
 */
async function releaseBookingCrew(bookingId: string): Promise<void> {
  try {
    const { driver_id, truck_id } = await crewOnBooking(bookingId)
    await releaseCrew(driver_id, truck_id)
  } catch (err) {
    console.error('[booking] failed to release crew for booking', bookingId, err)
  }
}

/**
 * The general manager's decision — the only approval gate on a booking. An
 * appointed GM proxy (an accountant the IT admin nominated) may act here too;
 * the route guard decides who gets in.
 *
 * A rejection carries the GM's remarks and cancels the booking, so it drops out
 * of the queue instead of sitting there un-actionable. The remarks are stored on
 * the booking and shown to the client in the rejection notification.
 */
export async function gmReviewService(
  bookingId: string,
  input: GmReviewInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (existing.gm_status !== 'pending') {
    throw new Error(`Booking has already been reviewed by the general manager (status: ${existing.gm_status})`)
  }
  if (input.gm_status === 'rejected' && !input.rejection_reason?.trim()) {
    throw new Error('Remarks explaining the rejection are required')
  }

  const booking = await BookingModel.updateGmStatus(bookingId, input)
  if (!booking) throw new Error('Failed to update GM status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `gm_${input.gm_status}`,
    description: `Booking ${bookingRef(booking)} ${input.gm_status} by GM`,

  })

  if (input.gm_status === 'rejected') {
    const closed = await BookingModel.updateStatus(bookingId, 'cancelled')
    void notifyStage('rejected_gm', closed ?? booking, { reason: input.rejection_reason })
    return closed ?? booking
  }

  // approved: advance the lifecycle to 'approved' (so operations sees it) and
  // send to operations to select a vehicle and driver.
  const advanced = await BookingModel.updateStatus(bookingId, 'approved')
  void notifyStage('ops_pending', advanced ?? booking)

  return advanced ?? booking
}

export async function deleteBookingService(
  bookingId: string,
  userId?: string | null,
  ip?: string | null,
): Promise<boolean> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (NON_DELETABLE_STATUSES.includes(existing.status)) {
    throw new Error(`Cannot delete a booking with status '${existing.status}'`)
  }

  // A booking can be crewed while its own status is still 'pending' — assigning
  // only moves ops_status — so deleting one has to hand the driver and vehicle
  // back the way cancelling does. Read the crew BEFORE the delete: the delivery
  // row goes with the booking, and with it any way of knowing who was on it.
  const { driver_id, truck_id } = await crewOnBooking(bookingId)

  const result = await BookingModel.remove(bookingId)

  try {
    await releaseCrew(driver_id, truck_id)
  } catch (err) {
    console.error('[booking] failed to release crew for deleted booking', bookingId, err)
  }

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_deleted',
    description: `Booking ${bookingRef(existing)} deleted`,

  })

  return result
}

export async function getDestinationsByBookingService(bookingId: string): Promise<BookingDestination[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  return await BookingModel.findDestinationsByBookingId(bookingId) ?? []
}

export async function updateDestinationService(
  destinationId: string,
  input: UpdateDestinationInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingDestination> {
  const destination = await BookingModel.updateDestination(destinationId, input)
  if (!destination) throw new Error(`Destination with ID ${destinationId} not found`)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'destination_updated',
    description: `Destination ${destinationId} updated`,

  })

  return destination
}

export async function updateDestinationStatusService(
  destinationId: string,
  status: string,
  deliveredAt?: string,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingDestination> {
  const destination = await BookingModel.updateDestinationStatus(destinationId, status)
  if (!destination) throw new Error(`Destination with ID ${destinationId} not found`)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `destination_${status}`,
    description: `Destination ${destinationId} marked as ${status}`,

  })

  return destination
}

/* ── Driver trip progress ──────────────────────────────────────────────────
 *
 * The driver app confirms each stop MANUALLY from the navigation map: pickup
 * done -> route continues to the drop-offs, each drop-off done, then the whole
 * booking marked done. These services are the write side of that flow. They
 * differ from the admin `updateBookingStatus`/`updateDestinationStatus` routes
 * in two ways: the caller must be the driver actually assigned to the booking
 * (admins bypass for support), and each transition is validated against the
 * stage before it, so a stop can't be confirmed out of order.
 *
 * All three are idempotent — re-sending a confirmation (the mobile offline
 * queue retries) returns the current record instead of failing.
 */

export interface DriverActor {
  userId?: string | null
  role?:   string | null
  ip?:     string | null
}

async function assertDriverOnBooking(bookingId: string, actor: DriverActor): Promise<BookingWithRelations> {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  // Admins act on any booking (support / correction); a driver only on their own.
  if (actor.role === 'admin') return booking

  const assigned = actor.userId
    ? await BookingModel.isDriverAssignedToBooking(bookingId, actor.userId)
    : false
  if (!assigned) throw new Error('You are not assigned to this booking')

  return booking
}

/**
 * Pickup confirmed by the driver: the booking moves to `in_transit`.
 * `proofPhotoUrl` is the photo taken at the origin and is required — a stop
 * can't be confirmed without proof.
 */
export async function driverConfirmPickupService(
  bookingId: string,
  proofPhotoUrl: string,
  actor: DriverActor,
  earlyStart = false,
  position?: StopProofPosition | null,
): Promise<BookingWithRelations> {
  const booking = await assertDriverOnBooking(bookingId, actor)

  if (booking.status === 'in_transit' || booking.status === 'completed') return booking
  if (booking.status !== 'assigned') {
    throw new Error(`Cannot confirm pickup while the booking is '${booking.status}'`)
  }
  if (!proofPhotoUrl) {
    throw new Error('A proof-of-pickup photo is required to confirm the pickup')
  }

  // A pickup stamps the booking `in_transit` and starts the proof trail every
  // drop-off hangs off, so it must not land days before the job is due. The app
  // gates this too, but a device clock is the driver's to set — this is the
  // check that actually holds. Starting early stays possible when the driver
  // deliberately overrides it, and that decision is recorded below.
  const early = isBeforeScheduledDay(booking.schedule_date)
  if (early && !earlyStart) {
    throw new Error(
      `Cannot confirm pickup before the scheduled day — this booking is scheduled for ${booking.schedule_date}.`,
    )
  }

  // Confirmed on site, or confirmed elsewhere for a stated reason. Runs after
  // the schedule and proof checks so the driver is told about one problem at a
  // time, and before anything is written so a refused confirmation leaves the
  // booking exactly as it was.
  const fence = assertStopProximity(
    stopCoordinates((booking as any).origin_latitude, (booking as any).origin_longitude),
    position,
    'pickup point',
  )

  await BookingModel.setPickupProof(bookingId, proofPhotoUrl, position, fence)
  const updated = await BookingModel.updateStatus(bookingId, 'in_transit')
  if (!updated) throw new Error('Failed to update booking status')

  if (fence.override_reason) {
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      'driver_pickup_confirmed_off_site',
      description: `Driver confirmed pickup for booking ${bookingRef(updated)} about ${fence.distance_m} m from the origin — reason given: ${fence.override_reason}`,
    })
  }

  // The delivery record tracks the same trip and has to move with it — it is
  // what operations reads to see who is actually on the road.
  await BookingModel.settleDelivery(bookingId, 'in_transit')

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      early ? 'driver_pickup_confirmed_early' : 'driver_pickup_confirmed',
    description: early
      ? `Driver confirmed pickup for booking ${bookingRef(updated)} EARLY — scheduled for ${booking.schedule_date}; booking is in transit`
      : `Driver confirmed pickup for booking ${bookingRef(updated)}; booking is in transit`,
  })

  return updated
}

/**
 * One drop-off confirmed by the driver. `proofPhotoUrl` is the photo taken at
 * that drop-off and is required.
 */
export async function driverConfirmDeliveryService(
  bookingId: string,
  destinationId: string,
  proofPhotoUrl: string,
  actor: DriverActor,
  position?: StopProofPosition | null,
): Promise<BookingDestination> {
  const booking      = await assertDriverOnBooking(bookingId, actor)
  const destinations = await BookingModel.findDestinationsByBookingId(bookingId) ?? []
  const destination  = destinations.find((d) => d.destination_id === destinationId)

  if (!destination) {
    throw new Error(`Destination with ID ${destinationId} not found on this booking`)
  }
  if (destination.status === 'delivered') return destination
  if (booking.status !== 'in_transit' && booking.status !== 'completed') {
    throw new Error('Confirm the pickup before marking a drop-off as delivered')
  }
  if (!proofPhotoUrl) {
    throw new Error('A proof-of-delivery photo is required to confirm this drop-off')
  }

  const fence = assertStopProximity(
    stopCoordinates(destination.latitude, destination.longitude),
    position,
    'drop-off',
  )

  const updated = await BookingModel.updateDestinationStatus(
    destinationId, 'delivered', proofPhotoUrl, position, fence,
  )
  if (!updated) throw new Error(`Destination with ID ${destinationId} not found`)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_delivery_confirmed',
    description: `Driver marked destination ${destinationId} of booking ${bookingRef(booking)} as delivered`,
  })

  if (fence.override_reason) {
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      'driver_delivery_confirmed_off_site',
      description: `Driver confirmed drop-off ${destinationId} of booking ${bookingRef(booking)} about ${fence.distance_m} m away — reason given: ${fence.override_reason}`,
    })
  }

  // The last stop closes the job. The driver used to have to tap "mark delivery
  // as done" as a separate step, so a booking whose every drop-off was confirmed
  // sat in 'in_transit' until they did — and if they closed the app first, it
  // sat there indefinitely, holding the driver and vehicle out of the pool.
  // Confirming the final drop-off IS finishing the delivery, so it says so.
  await completeBookingIfAllStopsDone(bookingId, actor)

  return updated
}

/**
 * Close the booking when no drop-off is still outstanding.
 *
 * Best effort, and deliberately silent when there is anything left to do: it
 * runs on every drop-off confirmation, and only the last one finishes the job.
 * A failure here must not fail the driver's confirmation — the stop is already
 * recorded, and the explicit completion endpoint still exists to finish it.
 */
async function completeBookingIfAllStopsDone(bookingId: string, actor: DriverActor): Promise<void> {
  try {
    const destinations = await BookingModel.findDestinationsByBookingId(bookingId) ?? []
    if (destinations.length === 0) return

    const outstanding = destinations.filter((d) => d.status !== 'delivered' && d.status !== 'failed')
    if (outstanding.length > 0) return

    await driverCompleteBookingService(bookingId, actor)
  } catch (err) {
    console.error('[booking] could not auto-complete booking', bookingId, err)
  }
}

/** Whole delivery marked done — only once every drop-off has been confirmed. */
export async function driverCompleteBookingService(
  bookingId: string,
  actor: DriverActor,
): Promise<BookingWithRelations> {
  const booking = await assertDriverOnBooking(bookingId, actor)

  if (booking.status === 'completed') return booking
  if (booking.status !== 'in_transit') {
    throw new Error(`Cannot complete a booking that is '${booking.status}'`)
  }

  const destinations = await BookingModel.findDestinationsByBookingId(bookingId) ?? []
  if (destinations.length === 0) {
    throw new Error('Booking has no destinations to deliver')
  }
  const remaining = destinations.filter((d) => d.status !== 'delivered' && d.status !== 'failed')
  if (remaining.length > 0) {
    throw new Error(`${remaining.length} drop-off(s) still pending — confirm every drop-off before completing`)
  }

  const updated = await BookingModel.updateStatus(bookingId, 'completed')
  if (!updated) throw new Error('Failed to update booking status')

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_booking_completed',
    description: `Driver marked booking ${bookingRef(updated)} as completed`,
  })

  // Close the delivery record before the crew is released — once the driver is
  // off the booking, `crewOnBooking` is the only thing that still knows who was
  // on it, and it reads that same row.
  await BookingModel.settleDelivery(bookingId, 'delivered')
  void releaseBookingCrew(bookingId)

  return updated
}

export async function deleteDestinationService(
  destinationId: string,
  userId?: string | null,
  ip?: string | null,
): Promise<boolean> {
  const result = await BookingModel.removeDestination(destinationId)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'destination_deleted',
    description: `Destination ${destinationId} deleted`,

  })

  return result
}

export async function getCargoItemsByBookingService(bookingId: string): Promise<BookingCargoItem[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  return await BookingModel.findCargoItemsByBookingId(bookingId) ?? []
}

export async function upsertCargoItemService(
  bookingId: string,
  item: Partial<BookingCargoItem> & { item_id?: string },
  userId?: string | null,
  ip?: string | null,
): Promise<BookingCargoItem> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  const result = await BookingModel.upsertCargoItem(bookingId, item)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      item.item_id ? 'cargo_item_updated' : 'cargo_item_created',
    description: `Cargo item ${result.item_id} upserted for booking ${bookingRef(existing)}`,

  })

  return result
}

export async function deleteCargoItemService(
  itemId: string,
  userId?: string | null,
  ip?: string | null,
): Promise<boolean> {
  const result = await BookingModel.removeCargoItem(itemId)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'cargo_item_deleted',
    description: `Cargo item ${itemId} deleted`,

  })

  return result
}
