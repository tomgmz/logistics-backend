import { BookingModel } from '../../models/client/booking.model.js'
import {
  CreateBookingRequest,
  ResubmitBookingInput,
  BookingRevision,
  UpdateBookingInput,
  UpdateDestinationInput,
  BookingWithRelations,
  BookingDestination,
  BookingCargoItem,
  GmReviewInput,
} from '../../types/client/booking.types.js'
import { findClientVisibleForBooking } from '../../models/admin/documents.model.js'
import type { ClientBookingDocument } from '../../types/documents.types.js'
import { optimizeDestinationsService } from '../maps/routeOptimization.service.js'
import { invalidateEta } from '../maps/eta.service.js'
import { MAX_DESTINATIONS_PER_BOOKING } from '../../lib/booking-limits.js'
import { logEvent } from '../../lib/log-event.js'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'
import { bookingRef, bookingRefById } from '../../lib/booking-ref.js'
import { isBeforeScheduledDay, phDay, phDayPlusMonth, phTimeHHMM, sameDayBookingOpen } from '../../lib/ph-date.js'
import { notifyStage, hasGmApprovers, emailDeliveryConfirm } from '../notification/notification.service.js'
import { refreshPlannedEta } from '../maps/planned-eta.service.js'
import { revokeVendorCrewAfterCompletion } from '../auth/driver-enrollment.service.js'
import { assertBookingVehicleInService, crewOnBooking, releaseCrew } from '../admin/fleet-availability.service.js'
import {
  assertStopProximity,
  stopCoordinates,
  type GeofenceOutcome,
  type StopProofPosition,
} from '../../lib/stop-geofence.js'
import { claimDeliveryStart } from '../driver/start-delivery.service.js'
import { assertNoPendingLoadTransfer } from '../driver/crew-actor.js'

/**
 * How far ahead a client has to book: today until 12:00 noon (Monday to
 * Saturday, see sameDayBookingOpen), otherwise tomorrow at the earliest; one
 * month out at the latest.
 *
 * Compared in Philippine calendar days, matching the `date` column — the
 * server's own timezone must not decide what "today" means to a client in
 * Manila.
 *
 * Every day of the week is open for transit, Sundays included. Office hours
 * only decide whether today is still offered, never which days a truck can run.
 */
function validateScheduleDate(scheduleDate: string, callTime?: string): void {
  const scheduled = scheduleDate.slice(0, 10)
  const today     = phDay()

  if (scheduled === today) {
    if (!sameDayBookingOpen()) {
      throw badRequest('Same-day bookings close at 12:00 noon, Monday to Saturday. Please pick a later date.')
    }
    // A same-day call time already gone is no booking at all.
    if (callTime && callTime.slice(0, 5) <= phTimeHHMM()) {
      throw badRequest('For a same-day booking, the call time must be later than now')
    }
    return
  }

  if (scheduled < today) {
    throw badRequest('Booking date cannot be in the past')
  }

  // At most one month ahead (company rule, 2026-10-12): the same calendar day
  // next month is the last bookable day.
  const latest = phDayPlusMonth()
  if (scheduled > latest) {
    throw badRequest(`Booking cannot be scheduled more than 1 month in advance (latest: ${latest})`)
  }
}

const NON_DELETABLE_STATUSES = ['approved', 'assigned', 'in_transit', 'delivered', 'completed']

/**
 * Who is asking, resolved from the session by `attachClientScope`.
 *
 * `clientId` is set only for client-role callers; every other role carries null
 * and is unaffected by the checks below. Passing this is deliberately mandatory
 * on every function that can reach a booking: an optional viewer would let a
 * forgotten call site silently skip the ownership check, which is the one
 * failure mode a scoping fix must not have.
 */
export interface BookingViewer {
  role:     string
  clientId: string | null
  /** The caller's own driver row, when they are a driver. */
  driverId?: string | null
}

const isClientViewer = (viewer: BookingViewer): boolean => viewer.role === 'client'
const isDriverViewer = (viewer: BookingViewer): boolean => viewer.role === 'driver'

/**
 * A client may only ever reach their own bookings, and a driver only the
 * bookings they are crewed on (as main or second driver). Staff pass straight
 * through.
 *
 * The driver half needs `driverId` from attachDriverScope on the route; a
 * driver without one (no driver row, or a route that forgot the middleware)
 * reaches nothing, which is the safe way for that mistake to fail.
 *
 * Reported as "not found" rather than "forbidden" so the reply never confirms
 * that another company's booking exists.
 */
function assertBookingOwnership(
  booking: { client_id: string; driver_assignments?: Array<{ driver_id: string }> | null },
  viewer: BookingViewer,
): void {
  if (isClientViewer(viewer)) {
    if (!viewer.clientId || booking.client_id !== viewer.clientId) {
      throw new Error('Booking not found')
    }
    return
  }
  if (isDriverViewer(viewer)) {
    const onCrew = !!viewer.driverId &&
      (booking.driver_assignments ?? []).some((a) => a.driver_id === viewer.driverId)
    if (!onCrew) throw new Error('Booking not found')
  }
}

/** The driver half of the rule, for callers that hold only a booking id. */
async function assertDriverOnCrew(bookingId: string, viewer: BookingViewer, what = 'Booking'): Promise<void> {
  const ok = !!viewer.driverId && await BookingModel.isDriverIdOnBooking(bookingId, viewer.driverId)
  if (!ok) throw new Error(`${what} with ID ${bookingId} not found`)
}

/**
 * The same ownership rule, for callers that hold only a booking id and do not
 * want the booking itself — the live-position read and the route geometry.
 *
 * Costs one narrow query, and only ever for a client; every other role returns
 * before it runs. Reported as "not found" for the reason above.
 */
export async function assertBookingVisible(
  bookingId: string,
  viewer:    BookingViewer,
): Promise<void> {
  if (isDriverViewer(viewer)) return assertDriverOnCrew(bookingId, viewer)
  if (!isClientViewer(viewer)) return
  const owner = await BookingModel.findBookingOwner(bookingId)
  if (!owner || !viewer.clientId || owner.client_id !== viewer.clientId) {
    throw new Error(`Booking with ID ${bookingId} not found`)
  }
}

/**
 * Ownership of a stop is ownership of its booking. Costs one extra query, and
 * only ever for a client — staff and the driver app return before it runs.
 */
async function assertDestinationOwnership(
  destinationId: string,
  viewer:        BookingViewer,
): Promise<void> {
  if (isDriverViewer(viewer)) {
    const owner = await BookingModel.findDestinationOwner(destinationId)
    if (!owner) throw new Error(`Destination with ID ${destinationId} not found`)
    return assertDriverOnCrew(owner.booking_id, viewer, 'Destination')
  }
  if (!isClientViewer(viewer)) return
  const owner = await BookingModel.findDestinationOwner(destinationId)
  if (!owner || !viewer.clientId || owner.client_id !== viewer.clientId) {
    throw new Error(`Destination with ID ${destinationId} not found`)
  }
}

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
  dateFrom?: string | null
  dateTo?:   string | null
}, viewer: BookingViewer): Promise<{ data: BookingWithRelations[]; meta: PaginatedBookingsMeta }> {
  const page  = Math.max(1, params.page)
  const limit = Math.min(Math.max(1, params.limit), 100)

  const clientId = isClientViewer(viewer) ? viewer.clientId : null

  // A client whose account resolves to no company sees nothing rather than
  // falling through to the unscoped query. `attachClientScope` already 403s
  // this case; belt and braces, because the cost of being wrong here is a leak.
  if (isClientViewer(viewer) && !clientId) {
    return {
      data: [],
      meta: { total: 0, page, limit, totalPages: 1, statusCounts: { all: 0 } },
    }
  }

  const [{ rows, total }, statusCounts] = await Promise.all([
    BookingModel.findAllPaginated({ page, limit, status: params.status, search: params.search, dateFrom: params.dateFrom, dateTo: params.dateTo, clientId }),
    BookingModel.countByStatus(clientId),
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


export async function getAllBookingsService(viewer: BookingViewer): Promise<BookingWithRelations[]> {
  // Same select and ordering as findAll, so the response shape is unchanged —
  // a client just never sees another company's rows in it.
  if (isClientViewer(viewer)) {
    return viewer.clientId ? (await BookingModel.findByClientId(viewer.clientId) ?? []) : []
  }
  return await BookingModel.findAll() ?? []
}

export async function getBookingByIdService(
  bookingId: string,
  viewer:    BookingViewer,
): Promise<BookingWithRelations> {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(booking, viewer)

  // A driver is told which seat they hold, so the app can show the trip
  // controls to the main driver and a read-only view to the second driver.
  if (isDriverViewer(viewer) && viewer.driverId) {
    const mine = booking.driver_assignments?.find((a) => a.driver_id === viewer.driverId)
    if (mine) booking.my_crew_role = mine.crew_role === 'second' ? 'second' : 'lead'
  }
  return booking
}

export async function getBookingsByClientService(
  clientId: string,
  viewer:   BookingViewer,
): Promise<BookingWithRelations[]> {
  // Pinned, not rejected: a client always gets their own list whatever id the
  // URL carries. Rejecting would turn a merely stale cached client_id in the
  // browser into a 404, and the outcome we care about is identical.
  const scoped = isClientViewer(viewer) ? viewer.clientId : clientId
  if (!scoped) return []
  return await BookingModel.findByClientId(scoped) ?? []
}

/**
 * A driver's bookings.
 *
 * Pinned to the caller's own driver id for a driver, exactly as the client list
 * is: the route takes `:driverId` from the URL, and trusting it let any driver
 * read another's whole run sheet — client company, origins, drop-offs, cargo and
 * schedule. Operations and admins still pass whatever the URL carries, because
 * dispatch legitimately reads any driver's day.
 *
 * A driver whose row could not be resolved scopes to nothing rather than
 * falling back to the URL, so a lookup failure cannot widen access.
 */
export async function getBookingsByDriverService(
  driverId: string,
  viewer:   BookingViewer,
): Promise<BookingWithRelations[]> {
  const scoped = isDriverViewer(viewer) ? viewer.driverId : driverId
  if (!scoped) return []
  return await BookingModel.findByDriverId(scoped) ?? []
}

export async function createBookingService(
  input: CreateBookingRequest,
  viewer: BookingViewer,
  userId?: string | null,
): Promise<BookingWithRelations> {
  // The owning company is never taken from the request body for a client: the
  // session decides, so a client cannot file a booking against another company.
  // A non-client caller may still name one, leaving booking-on-behalf possible
  // without another change here.
  const clientId = isClientViewer(viewer) ? viewer.clientId : input.client_id
  if (!clientId) throw badRequest('client_id is required')

  if (!input.destinations || input.destinations.length === 0) {
    throw badRequest('At least one destination is required')
  }
  if (input.destinations.length > MAX_DESTINATIONS_PER_BOOKING) {
    throw badRequest(`A booking can have at most ${MAX_DESTINATIONS_PER_BOOKING} drop-offs`)
  }

  validateScheduleDate(input.schedule_date, input.call_time)

  const orders = input.destinations.map((d) => d.sequence_order)
  if (new Set(orders).size !== orders.length) {
    throw badRequest('sequence_order must be unique per destination')
  }

  const booking = await BookingModel.create({ ...input, client_id: clientId })
  if (!booking) throw new Error('Failed to create booking')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_created',
    description: `Booking ${bookingRef(booking)} created for client ${booking.client_id}`,

  })

  // Stage 1: straight to the general manager for approval.
  void routeNewBookingToGm(booking, userId)

  // Put the stops in driving order — AFTER the reply, never before it.
  void reoptimizeBookingStops(booking)

  return booking
}

/**
 * Reorder a booking's drop-offs into Google's suggested driving order.
 *
 * This used to run inline, before the insert, and it was the single slowest
 * thing about creating a booking: an OAuth exchange plus a call to a
 * vehicle-routing solver, occasionally twice when the first attempt came back
 * with no visits — none of it with a timeout, so a hung Google request hung the
 * client's "Book Transit" spinner with it, indefinitely.
 *
 * None of that needs to happen before the client is told their booking exists.
 * Stop order matters to the driver, who sees it at assignment time at the
 * earliest, and a booking with the client's own ordering is perfectly usable
 * until then. So the booking is committed and acknowledged first and the order
 * is improved a moment later; if Google is slow, broken, or refuses the route,
 * the booking simply keeps the order the client entered.
 */
async function reoptimizeBookingStops(booking: BookingWithRelations): Promise<void> {
  try {
    const stops = booking.booking_destinations ?? []
    // One stop has no order to optimise.
    if (stops.length < 2) return

    const originHasCoords = booking.origin_latitude != null && booking.origin_longitude != null
    const allHaveCoords   = stops.every((d) => d.latitude != null && d.longitude != null)
    if (!originHasCoords || !allHaveCoords) return

    const ordered = [...stops].sort((a, b) => a.sequence_order - b.sequence_order)

    const optimized = await optimizeDestinationsService(
      { latitude: Number(booking.origin_latitude), longitude: Number(booking.origin_longitude) },
      ordered.map((d) => ({
        address:        d.address,
        latitude:       Number(d.latitude),
        longitude:      Number(d.longitude),
        sequence_order: d.sequence_order,
      })),
      booking.schedule_date,
      booking.call_time,
    )

    // Results come back keyed by position in the list above, so a repeated
    // address cannot pull two stops onto the same number.
    const order = optimized.map((o) => ({
      destination_id: ordered[o.index].destination_id,
      sequence_order: o.optimized_sequence_order,
    }))

    // Every stop must be accounted for, or the write would leave a gap.
    if (order.length !== ordered.length) return

    const unchanged = order.every(
      (o, i) => o.destination_id === ordered[i].destination_id && o.sequence_order === ordered[i].sequence_order,
    )
    if (unchanged) return

    const applied = await BookingModel.resequenceDestinations(booking.booking_id, order)
    if (!applied) {
      console.warn('[booking] stop order changed while optimising; keeping the current order', booking.booking_id)
    }
  } catch (err) {
    console.warn('[booking] route optimisation failed; keeping the order the client entered', booking.booking_id, err)
  }
}

/**
 * Send a freshly created (or resubmitted) booking into the approval chain by
 * notifying the GM stage. A booking is never approved without a person: with
 * no active General Manager or Company Administrator it stays pending in the
 * approval queue until one exists and approves it (that used to auto-approve,
 * removed 2026-10-24).
 */
async function routeNewBookingToGm(
  booking: BookingWithRelations,
  userId?: string | null,
): Promise<void> {
  try {
    if (!(await hasGmApprovers())) {
      // Nobody to notify; the booking waits in the queue for the first approver.
      console.warn('[booking] no active General Manager or Company Administrator; booking left pending',
        booking.booking_id, { submitted_by: userId ?? null })
      return
    }
    await notifyStage('gm_pending', booking)
  } catch (err) {
    console.error('[booking] failed to route new booking to the GM stage', booking.booking_id, err)
  }
}

export async function updateBookingService(
  bookingId: string,
  input: UpdateBookingInput,
  viewer: BookingViewer,
  userId?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)

  if (input.schedule_date) {
    validateScheduleDate(input.schedule_date, input.call_time ?? existing.call_time ?? undefined)
  }

  const booking = await BookingModel.update(bookingId, input)
  if (!booking) throw new Error('Failed to update booking')

  // A moved departure or pickup point moves every planned arrival. No-op unless
  // the booking is crewed.
  const moved = ['schedule_date', 'call_time', 'origin_latitude', 'origin_longitude']
    .some((k) => k in (input as Record<string, unknown>))
  if (moved) void refreshPlannedEta(bookingId)

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
  viewer: BookingViewer,
  userId?: string | null,
  // The administrator's remarks when turning a booking down. Stored on the
  // booking and sent to the client with the rejection notification.
  rejectionReason?: string | null,
  // The administrator's remarks when approving. Required to approve, and shown
  // in the client's and the admin transaction history.
  approvalRemarks?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)

  const statusOrder  = ['pending', 'approved', 'assigned', 'in_transit', 'delivered', 'completed', 'cancelled']
  const currentIndex = statusOrder.indexOf(existing.status)
  const newIndex     = statusOrder.indexOf(status)

  if (newIndex === currentIndex) return existing

  // Past the drop-offs, the only way forward is confirmation. The crew is
  // already released and the delivery settled, so none of the completion side
  // effects below may run a second time.
  if (status === 'completed' && existing.status === 'delivered') {
    if (viewer.role !== 'client') {
      throw new Error("Cannot change status to 'completed' — only the client can confirm a delivered booking")
    }
    return confirmCompletionService(bookingId, viewer, userId)
  }
  if (status === 'delivered') {
    throw new Error("Cannot change status to 'delivered' by hand — it is set when the driver finishes the last drop-off")
  }

  if (newIndex < currentIndex && status !== 'cancelled') {
    throw new Error(`Cannot change status from '${existing.status}' back to '${status}'`)
  }

  // Approving is a decision with remarks, same as rejecting. Checked before any
  // write, matching the condition of the approval branch below.
  const approving = status === 'approved' && existing.status !== 'approved' && existing.ops_status !== 'assigned'
  if (approving && !approvalRemarks?.trim()) {
    throw new Error("Cannot change status to 'approved' without remarks. Add remarks to approve the booking.")
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
      ? `Booking ${bookingRef(booking)} rejected by the Administrator: ${rejectionReason}`
      : `Booking ${bookingRef(booking)} marked as ${status}`,

  })

  // Approving the booking via the top-level status control hands it to
  // operations: clear a still-pending GM stage so the record is consistent, then
  // notify the operations manager to select a vehicle and driver.
  if (approving) {
    if (existing.gm_status === 'pending') {
      await BookingModel.setGmStatus(bookingId, { gm_status: 'approved', approval_remarks: approvalRemarks!.trim() })
    } else {
      await BookingModel.setApprovalRemarks(bookingId, approvalRemarks!.trim())
    }
    // The Company Admin approved it on their own authority; record that it was them.
    await BookingModel.recordDecision(bookingId, 'gm', userId)
    const advanced = await BookingModel.findById(bookingId)
    logEvent({
      user_id:     userId,
      log_type:    'booking',
      action:      'booking_approved_to_ops',
      description: `Booking ${bookingRef(advanced ?? booking)} approved; routed to the Operations Manager. Remarks: ${approvalRemarks!.trim()}`,
    })
    void notifyStage('ops_pending', advanced ?? booking)
    void notifyStage('approved_admin', advanced ?? booking, { reason: approvalRemarks!.trim() })
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
    const { driver_id, truck_id, second_driver_id } = await crewOnBooking(bookingId)
    await releaseCrew(driver_id, truck_id, second_driver_id)
  } catch (err) {
    console.error('[booking] failed to release crew for booking', bookingId, err)
  }
}

/**
 * The general manager's decision — the only approval gate on a booking. An
 *
 * A rejection carries the GM's remarks and cancels the booking, so it drops out
 * of the queue instead of sitting there un-actionable. The remarks are stored on
 * the booking and shown to the client in the rejection notification.
 */
export async function gmReviewService(
  bookingId: string,
  input: GmReviewInput,
  userId?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (existing.gm_status !== 'pending') {
    throw new Error(`Booking has already been reviewed by the General Manager (status: ${existing.gm_status})`)
  }
  if (input.gm_status === 'rejected' && !input.rejection_reason?.trim()) {
    throw new Error('Remarks explaining the rejection are required')
  }
  if (input.gm_status === 'approved' && !input.approval_remarks?.trim()) {
    throw new Error('Remarks are required to approve a booking')
  }

  const booking = await BookingModel.updateGmStatus(bookingId, {
    ...input,
    approval_remarks: input.approval_remarks?.trim(),
  })
  if (!booking) throw new Error('Failed to update General Manager status')
  await BookingModel.recordDecision(bookingId, 'gm', userId)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `gm_${input.gm_status}`,
    description: `Booking ${bookingRef(booking)} ${input.gm_status} by General Manager`
      + (input.gm_status === 'approved' ? `. Remarks: ${input.approval_remarks!.trim()}` : ''),

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
  void notifyStage('approved_gm', advanced ?? booking, { reason: input.approval_remarks!.trim() })

  return advanced ?? booking
}

/**
 * Whether a booking is an 8338 rejection still waiting on the client: turned
 * down by the General Manager or cancelled by the Company Administrator, never
 * crewed, and not yet closed by the client. Only these can be resubmitted or
 * closed — a booking that had a driver and vehicle on it was cancelled for
 * operational reasons, and resubmitting it would leave the old delivery record
 * behind.
 */
function isAwaitingClientAfterRejection(booking: BookingWithRelations): boolean {
  return booking.status === 'cancelled'
    && !booking.client_closed_at
    && booking.ops_status !== 'assigned'
    && (booking.gm_status === 'rejected' || !!booking.cancelled_by)
}

/**
 * The client corrected a rejected booking and sends it back for review. It is
 * rewritten in place (same id, same reference) and goes through the approval
 * chain exactly as a new booking would — every rule `createBookingService`
 * applies to a new booking applies here too.
 */
export async function resubmitBookingService(
  bookingId: string,
  input: ResubmitBookingInput,
  viewer: BookingViewer,
  userId?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw notFound('Booking not found')
  assertBookingOwnership(existing, viewer)

  if (!isAwaitingClientAfterRejection(existing)) {
    throw conflict('Only a rejected booking can be resubmitted')
  }

  if (!input.destinations || input.destinations.length === 0) {
    throw badRequest('At least one destination is required')
  }
  if (input.destinations.length > MAX_DESTINATIONS_PER_BOOKING) {
    throw badRequest(`A booking can have at most ${MAX_DESTINATIONS_PER_BOOKING} drop-offs`)
  }

  validateScheduleDate(input.schedule_date, input.call_time)

  const orders = input.destinations.map((d) => d.sequence_order)
  if (new Set(orders).size !== orders.length) {
    throw badRequest('sequence_order must be unique per destination')
  }

  const booking = await BookingModel.resubmit(bookingId, input, userId)
  if (!booking) throw conflict('Only a rejected booking can be resubmitted')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_resubmitted',
    description: `Booking ${bookingRef(booking)} corrected and resubmitted by the client` +
                 (existing.rejection_reason ? ` (previously rejected: ${existing.rejection_reason})` : ''),
  })

  void routeNewBookingToGm(booking, userId)
  void reoptimizeBookingStops(booking)

  return booking
}

/**
 * The client does not want to correct a rejected booking. It stays cancelled
 * and is taken off their Needs Your Attention list for good.
 */
export async function closeRejectedBookingService(
  bookingId: string,
  viewer: BookingViewer,
  userId?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw notFound('Booking not found')
  assertBookingOwnership(existing, viewer)

  if (!isAwaitingClientAfterRejection(existing)) {
    throw conflict('Only a rejected booking can be cancelled this way')
  }

  const booking = await BookingModel.closeByClient(bookingId)
  if (!booking) throw conflict('Only a rejected booking can be cancelled this way')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_closed_by_client',
    description: `Rejected booking ${bookingRef(booking)} cancelled by the client instead of resubmitted`,
  })

  return booking
}

export async function deleteBookingService(
  bookingId: string,
  viewer: BookingViewer,
  userId?: string | null,
): Promise<boolean> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)

  if (NON_DELETABLE_STATUSES.includes(existing.status)) {
    throw new Error(`Cannot delete a booking with status '${existing.status}'`)
  }

  // A booking can be crewed while its own status is still 'pending' — assigning
  // only moves ops_status — so deleting one has to hand the driver and vehicle
  // back the way cancelling does. Read the crew BEFORE the delete: the delivery
  // row goes with the booking, and with it any way of knowing who was on it.
  const { driver_id, truck_id, second_driver_id } = await crewOnBooking(bookingId)

  const result = await BookingModel.remove(bookingId)

  try {
    await releaseCrew(driver_id, truck_id, second_driver_id)
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

export async function getDestinationsByBookingService(
  bookingId: string,
  viewer:    BookingViewer,
): Promise<BookingDestination[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)
  return await BookingModel.findDestinationsByBookingId(bookingId) ?? []
}

/**
 * Every file on the booking that its client may see: their own attachments,
 * the pickup and drop-off proof photos, and approved shipment paperwork from
 * staff. Ownership is checked the same way as the booking itself, so a client
 * can only ever read their own company's files.
 */
export async function getBookingDocumentsService(
  bookingId: string,
  viewer:    BookingViewer,
): Promise<ClientBookingDocument[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)
  return await findClientVisibleForBooking(bookingId)
}

/**
 * The old and resubmitted values of every resubmission of a booking, for the
 * client and the staff who can see the booking. Empty for a booking that was
 * never resubmitted.
 */
export async function getBookingRevisionsService(
  bookingId: string,
  viewer:    BookingViewer,
): Promise<BookingRevision[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)
  return BookingModel.findRevisions(bookingId)
}

export async function updateDestinationService(
  destinationId: string,
  input: UpdateDestinationInput,
  viewer: BookingViewer,
  userId?: string | null,
): Promise<BookingDestination> {
  await assertDestinationOwnership(destinationId, viewer)

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
  viewer: BookingViewer,
  deliveredAt?: string,
  userId?: string | null,
): Promise<BookingDestination> {
  await assertDestinationOwnership(destinationId, viewer)

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
}

export async function assertDriverOnBooking(bookingId: string, actor: DriverActor): Promise<BookingWithRelations> {
  return (await driverSeatOnBooking(bookingId, actor)).booking
}

/**
 * The same check, plus which seat the driver holds. Admins count as the main
 * driver: they act on any booking for support or correction.
 */
export async function driverSeatOnBooking(
  bookingId: string,
  actor: DriverActor,
): Promise<{ booking: BookingWithRelations; seat: 'lead' | 'second' }> {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  if (actor.role === 'admin') return { booking, seat: 'lead' }

  const seat = actor.userId ? await BookingModel.driverCrewRole(bookingId, actor.userId) : null
  if (!seat) throw new Error('You are not assigned to this booking')

  return { booking, seat }
}

/**
 * For every write a driver makes on the trip — pickup, stops, proof photos,
 * finishing, the vehicle's return. Only the main driver does those in the app,
 * so the record has one author and one phone. The second driver can see the
 * booking and its stops but is refused here.
 */
export async function assertLeadDriverOnBooking(bookingId: string, actor: DriverActor): Promise<BookingWithRelations> {
  const { booking, seat } = await driverSeatOnBooking(bookingId, actor)
  if (seat !== 'lead') {
    throw new Error('Only the main driver can update this delivery in the app. You are the second driver on this booking.')
  }
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
  const booking = await assertLeadDriverOnBooking(bookingId, actor)

  // Already loaded (a queue retry), or long past it. 'in_transit' alone no longer
  // means loaded: Start Navigation puts the booking there on the way TO the pickup.
  if (booking.pickup_proof_photo_url || booking.status === 'delivered' || booking.status === 'completed') return booking
  if (booking.status !== 'assigned' && booking.status !== 'in_transit') {
    throw new Error(`Cannot confirm pickup while the booking is '${booking.status}'`)
  }
  if (!proofPhotoUrl) {
    throw new Error('A proof-of-pickup photo is required to confirm the pickup')
  }
  // The Fleet Manager pulled the vehicle after it was assigned.
  await assertBookingVehicleInService(bookingId)

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

  // Settles the crew under the booking row lock and moves the booking to
  // 'in_transit' if Start Navigation has not already — see claimDeliveryStart.
  await claimDeliveryStart(bookingId, actor)
  await BookingModel.setPickupProof(bookingId, proofPhotoUrl, position, fence)
  const updated = await BookingModel.findById(bookingId)
  if (!updated) throw new Error('Failed to update booking status')

  if (fence.override_reason) {
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      'driver_pickup_confirmed_off_site',
      description: `Driver confirmed pickup for booking ${bookingRef(updated)} about ${fence.distance_m} m from the origin — reason given: ${fence.override_reason}`,
    })
  }

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
  const booking      = await assertLeadDriverOnBooking(bookingId, actor)
  const destinations = await BookingModel.findDestinationsByBookingId(bookingId) ?? []
  const destination  = destinations.find((d) => d.destination_id === destinationId)

  if (!destination) {
    throw new Error(`Destination with ID ${destinationId} not found on this booking`)
  }
  if (destination.status === 'delivered') return destination
  const loaded = booking.status === 'delivered' || booking.status === 'completed' ||
    (booking.status === 'in_transit' && !!booking.pickup_proof_photo_url)
  if (!loaded) {
    throw new Error('Confirm the pickup before marking a drop-off as delivered')
  }
  await assertNoPendingLoadTransfer(bookingId)
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

  // The remaining route just lost a stop, so every cached arrival time after it
  // is wrong by however long the driver spent at this bay. Clearing the stamp
  // makes the next position ping buy a fresh estimate. Fire-and-forget: a stale
  // ETA is not worth failing a confirmed delivery over.
  void invalidateEta(bookingId).catch(() => {})

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
  const booking = await assertLeadDriverOnBooking(bookingId, actor)

  if (booking.status === 'delivered' || booking.status === 'completed') return booking
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

  // The driver's part is done, but completion is the client's call: the booking
  // waits at 'delivered' for their confirmation (or the 3-day auto-complete).
  const updated = await BookingModel.markDelivered(bookingId)
  if (!updated) throw new Error('Failed to update booking status')

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_booking_delivered',
    description: `Driver finished every drop-off on booking ${bookingRef(updated)}; awaiting the client's confirmation`,
  })
  void notifyStage('delivery_confirm', updated)
  void emailDeliveryConfirm(updated, AUTO_COMPLETE_DAYS)

  // Close the delivery record before the crew is released — once the driver is
  // off the booking, `crewOnBooking` is the only thing that still knows who was
  // on it, and it reads that same row.
  await BookingModel.settleDelivery(bookingId, 'delivered')
  void releaseBookingCrew(bookingId)

  return updated
}

export async function deleteDestinationService(
  destinationId: string,
  viewer: BookingViewer,
  userId?: string | null,
): Promise<boolean> {
  // `removeDestination` reports success even when nothing matched, so without
  // this a client deleting a foreign stop got a silent 200. Now they get a 404.
  await assertDestinationOwnership(destinationId, viewer)

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

/* ── Completion: the client's call ────────────────────────────────────────── */

/** Days after delivery before an unconfirmed, undisputed booking completes itself. */
export const AUTO_COMPLETE_DAYS = 3

/**
 * Confirm a delivered booking is complete. Only the client can: staff cannot
 * confirm on their behalf (they mark a reported problem resolved instead, see
 * resolveDeliveryIssueService). A client with an open report can still
 * confirm, which withdraws it.
 */
export async function confirmCompletionService(
  bookingId: string,
  viewer:    BookingViewer,
  userId?:   string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)

  if (viewer.role !== 'client') {
    throw new Error('Only the client can confirm their booking is complete')
  }
  if (existing.status === 'completed') return existing
  if (existing.status !== 'delivered') {
    throw new Error(`Cannot confirm completion while the booking is '${existing.status}' — the driver has not finished yet`)
  }

  const done    = await BookingModel.markCompleted(bookingId, { by: userId ?? null, role: viewer.role, auto: false })
  const booking = (await BookingModel.findById(bookingId)) ?? existing
  if (!done) return booking // already completed (a double click, or the auto-complete)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_completion_confirmed_by_client',
    description: `Client confirmed booking ${bookingRef(booking)} is complete`,
  })
  void revokeVendorCrewAfterCompletion(bookingId, bookingRef(booking))

  return booking
}

/** Who may mark a client's reported problem resolved. */
const ISSUE_RESOLVERS = new Set(['admin', 'operations_manager'])

/**
 * Staff mark the problem the client reported as resolved. The booking stays
 * 'delivered' — completion is still the client's call — but the auto-complete
 * clock restarts: the client has a fresh 3 days to confirm or report again.
 */
export async function resolveDeliveryIssueService(
  bookingId: string,
  note:      string,
  viewer:    BookingViewer,
  userId?:   string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (!ISSUE_RESOLVERS.has(viewer.role)) {
    throw new Error('Only the Company Administrator or the Operations Manager can resolve a reported problem')
  }
  if (existing.status !== 'delivered') {
    throw new Error(`Cannot resolve a problem on a booking that is '${existing.status}'`)
  }
  const issue = existing as { client_issue_reported_at?: string | null; client_issue_resolved_at?: string | null }
  if (!issue.client_issue_reported_at) {
    throw new Error('Cannot resolve: the client has not reported a problem on this booking')
  }
  if (issue.client_issue_resolved_at) return existing

  // What was done about it goes to the client, so it is required.
  const remarks = note.trim()
  if (remarks.length < 5) throw new Error('Cannot resolve without remarks: write what was done about the problem')

  const done    = await BookingModel.resolveClientIssue(bookingId, userId ?? null, remarks)
  const booking = (await BookingModel.findById(bookingId)) ?? existing
  if (!done) return booking // resolved by someone else first

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_delivery_issue_resolved',
    description: `Problem reported on booking ${bookingRef(booking)} marked resolved (${remarks}); the client has ${AUTO_COMPLETE_DAYS} days to confirm`,
  })
  void notifyStage('delivery_issue_resolved', booking, { reason: remarks })

  return booking
}

/**
 * The client says the delivery is not right. The booking stays 'delivered'
 * (auto-complete is held) and operations is told so someone follows up.
 */
export async function reportDeliveryIssueService(
  bookingId: string,
  note:      string,
  viewer:    BookingViewer,
  userId?:   string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  assertBookingOwnership(existing, viewer)

  if (viewer.role !== 'client') {
    throw new Error('Only the client can report a problem with their delivery')
  }
  if (existing.status !== 'delivered') {
    throw new Error(`A problem can only be reported on a delivered booking (this one is '${existing.status}')`)
  }

  const clean   = note.trim()
  const booking = (await BookingModel.reportClientIssue(bookingId, clean, userId ?? null)) ?? existing

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_delivery_issue_reported',
    description: `Client reported a problem with booking ${bookingRef(booking)}: ${clean}`,
  })
  void notifyStage('delivery_issue', booking, { reason: clean })

  return booking
}

/** The scheduler's auto-complete. No actor: recorded as automatic. */
export async function autoCompleteBookingService(bookingId: string): Promise<boolean> {
  const done = await BookingModel.markCompleted(bookingId, { by: null, role: null, auto: true })
  if (!done) return false
  const ref = await bookingRefById(bookingId)
  void revokeVendorCrewAfterCompletion(bookingId, ref)
  logEvent({
    log_type:    'booking',
    action:      'booking_auto_completed',
    description: `Booking ${ref} completed automatically — no confirmation or problem report within ${AUTO_COMPLETE_DAYS} days of delivery`,
  })
  return true
}
