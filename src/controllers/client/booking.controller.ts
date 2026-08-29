import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import {
  getAllBookingsService,
  getAllBookingsPaginatedService,
  getBookingByIdService,
  getBookingsByClientService,
  getBookingsByDriverService,
  createBookingService,
  updateBookingService,
  updateBookingStatusService,
  deleteBookingService,
  gmReviewService,
  getDestinationsByBookingService,
  updateDestinationService,
  updateDestinationStatusService,
  driverConfirmPickupService,
  driverConfirmDeliveryService,
  driverCompleteBookingService,
  deleteDestinationService,
  getCargoItemsByBookingService,
  upsertCargoItemService,
  deleteCargoItemService,
  type BookingViewer,
} from '../../services/client/booking.service.js'
import {
  StopTooFarError,
  STOP_PROOF_RADIUS_M,
  type StopProofPosition,
} from '../../lib/stop-geofence.js'

/**
 * Who is asking, for the ownership checks in the service.
 *
 * `clientId` is put on the request by `attachClientScope`. The role defaults to
 * 'client' so a request that somehow arrives without a user — or a route wired
 * without that middleware — fails closed to empty results and 404s rather than
 * falling through as staff.
 */
function viewerFrom(req: Request): BookingViewer {
  return {
    role:     req.user?.role ?? 'client',
    clientId: req.clientId ?? null,
  }
}

export const getAllBookings = async (req: Request, res: Response) => {
  try {
    const pageRaw  = req.query.page
    const limitRaw = req.query.limit
    const page     = pageRaw  != null && pageRaw  !== '' ? parseInt(String(pageRaw),  10) : NaN
    const limit    = limitRaw != null && limitRaw !== '' ? parseInt(String(limitRaw), 10) : NaN

    if (Number.isFinite(page) && Number.isFinite(limit) && limit > 0 && page > 0) {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all'
      const search = typeof req.query.search === 'string' ? req.query.search : ''
      const result = await getAllBookingsPaginatedService({ page, limit, status, search }, viewerFrom(req))
      return res.status(200).json({ status: 'success', data: result.data, meta: result.meta })
    }

    const bookings = await getAllBookingsService(viewerFrom(req))
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const getBookingById = async (req: Request, res: Response) => {
  try {
    const booking = await getBookingByIdService(param(req.params.id), viewerFrom(req))
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getBookingsByClient = async (req: Request, res: Response) => {
  try {
    const bookings = await getBookingsByClientService(param(req.params.clientId), viewerFrom(req))
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getBookingsByDriver = async (req: Request, res: Response) => {
  try {
    const bookings = await getBookingsByDriverService(param(req.params.driverId))
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const createBooking = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await createBookingService(req.body, viewerFrom(req), userId, ip)
    res.status(201).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = (
      error.message.includes('required') ||
      error.message.includes('at most') ||
      error.message.includes('scheduled at least') ||
      error.message.includes('more than 1 year') ||
      error.message.includes('unique')
    ) ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateBooking = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await updateBookingService(param(req.params.id), req.body, viewerFrom(req), userId, ip)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found')
      ? 404
      : error.message.includes('scheduled at least') || error.message.includes('more than 1 year')
        ? 400
        : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateBookingStatus = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await updateBookingStatusService(
      param(req.params.id), req.body.status, viewerFrom(req), userId, ip, req.body.rejection_reason,
    )
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const isNotFound   = error.message.includes('not found')
    const isBadRequest = error.message.includes('Cannot change status')
    res.status(isNotFound ? 404 : isBadRequest ? 400 : 500).json({ status: 'error', message: error.message })
  }
}

export const deleteBooking = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    await deleteBookingService(param(req.params.id), viewerFrom(req), userId, ip)
    res.status(200).json({ status: 'success', message: 'Booking deleted successfully' })
  } catch (error: any) {
    const isNotFound   = error.message.includes('not found')
    const isBadRequest = error.message.includes("Cannot delete")
    res.status(isNotFound ? 404 : isBadRequest ? 400 : 500).json({ status: 'error', message: error.message })
  }
}

export const gmReview = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await gmReviewService(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already been') ? 409
      : error.message.includes('required') ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getDestinationsByBooking = async (req: Request, res: Response) => {
  try {
    const destinations = await getDestinationsByBookingService(param(req.params.id), viewerFrom(req))
    res.status(200).json({ status: 'success', data: destinations })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateDestination = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const destination = await updateDestinationService(param(req.params.destinationId), req.body, viewerFrom(req), userId, ip)
    res.status(200).json({ status: 'success', data: destination })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateDestinationStatus = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const { status }     = req.body
    const deliveredAt    = status === 'delivered' ? new Date().toISOString() : undefined
    const destination    = await updateDestinationStatusService(param(req.params.destinationId), status, viewerFrom(req), deliveredAt, userId, ip)
    res.status(200).json({ status: 'success', data: destination })
  } catch (error: any) {
    const httpStatus = error.message.includes('not found') ? 404 : 500
    res.status(httpStatus).json({ status: 'error', message: error.message })
  }
}

/* ── Driver trip progress (mobile navigation screen) ───────────────────── */

// Shared HTTP mapping for the three driver confirmations: 403 when the caller
// isn't the assigned driver, 404 for a missing booking/destination, 409 when the
// stop is confirmed out of order, 500 otherwise.
function driverProgressStatus(message: string): number {
  if (message.includes('not assigned'))  return 403
  if (message.includes('not found'))     return 404
  if (
    message.includes('Cannot ') ||
    message.includes('Confirm the pickup') ||
    message.includes('still pending') ||
    message.includes('no destinations')
  ) return 409
  return 500
}

function driverActor(req: Request) {
  const { userId, ip } = getRequestMeta(req)
  return { userId, ip, role: req.user?.role ?? null }
}

/**
 * The position the app captured when the driver confirmed the stop.
 *
 * Returns null when the phone had no fix, which the geofence treats as its own
 * case — the driver is told the location could not be read rather than being
 * quietly let through or shown a distance of zero.
 */
function stopProofPosition(req: Request): StopProofPosition | null {
  const { latitude, longitude, accuracy_m, override_reason } = req.body ?? {}
  const hasFix = typeof latitude === 'number' && typeof longitude === 'number'

  if (!hasFix) {
    // No coordinates, but a reason may still have been given — the geofence
    // needs to see it, so pass a position carrying only that.
    return override_reason
      ? { latitude: NaN, longitude: NaN, override_reason: String(override_reason) }
      : null
  }

  return {
    latitude,
    longitude,
    accuracy_m:      typeof accuracy_m === 'number' ? accuracy_m : null,
    override_reason: override_reason ? String(override_reason) : null,
  }
}

/**
 * A stop refused for being too far away answers 422: the request is well-formed
 * and the driver is who they say they are — it is the position that is wrong,
 * and the app has to tell them the distance rather than showing a generic error.
 */
function stopProofFailure(res: Response, error: any) {
  if (error instanceof StopTooFarError) {
    res.status(422).json({
      status:     'error',
      message:    error.message,
      code:       'STOP_TOO_FAR',
      distance_m: error.distance_m,
      radius_m:   STOP_PROOF_RADIUS_M,
    })
    return
  }
  res.status(driverProgressStatus(error.message)).json({ status: 'error', message: error.message })
}

export const driverConfirmPickup = async (req: Request, res: Response) => {
  try {
    const booking = await driverConfirmPickupService(
      param(req.params.bookingId),
      req.body.proof_photo_url,
      driverActor(req),
      req.body.early_start === true,
      stopProofPosition(req),
    )
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    stopProofFailure(res, error)
  }
}

export const driverConfirmDelivery = async (req: Request, res: Response) => {
  try {
    const destination = await driverConfirmDeliveryService(
      param(req.params.bookingId),
      param(req.params.destinationId),
      req.body.proof_photo_url,
      driverActor(req),
      stopProofPosition(req),
    )
    res.status(200).json({ status: 'success', data: destination })
  } catch (error: any) {
    stopProofFailure(res, error)
  }
}

export const driverCompleteBooking = async (req: Request, res: Response) => {
  try {
    const booking = await driverCompleteBookingService(param(req.params.bookingId), driverActor(req))
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    res.status(driverProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

export const deleteDestination = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    await deleteDestinationService(param(req.params.destinationId), viewerFrom(req), userId, ip)
    res.status(200).json({ status: 'success', message: 'Destination deleted successfully' })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getCargoItemsByBooking = async (req: Request, res: Response) => {
  try {
    const items = await getCargoItemsByBookingService(param(req.params.id))
    res.status(200).json({ status: 'success', data: items })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const upsertCargoItem = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const item = await upsertCargoItemService(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data: item })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const deleteCargoItem = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    await deleteCargoItemService(param(req.params.itemId), userId, ip)
    res.status(200).json({ status: 'success', message: 'Cargo item deleted successfully' })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}