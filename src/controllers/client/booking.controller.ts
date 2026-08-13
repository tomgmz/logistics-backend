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
  accountingReviewService,
  gmReviewService,
  opsAssignService,
  fleetApproveService,
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
} from '../../services/client/booking.service.js'

export const getAllBookings = async (req: Request, res: Response) => {
  try {
    const pageRaw  = req.query.page
    const limitRaw = req.query.limit
    const page     = pageRaw  != null && pageRaw  !== '' ? parseInt(String(pageRaw),  10) : NaN
    const limit    = limitRaw != null && limitRaw !== '' ? parseInt(String(limitRaw), 10) : NaN

    if (Number.isFinite(page) && Number.isFinite(limit) && limit > 0 && page > 0) {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all'
      const search = typeof req.query.search === 'string' ? req.query.search : ''
      const result = await getAllBookingsPaginatedService({ page, limit, status, search })
      return res.status(200).json({ status: 'success', data: result.data, meta: result.meta })
    }

    const bookings = await getAllBookingsService()
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const getBookingById = async (req: Request, res: Response) => {
  try {
    const booking = await getBookingByIdService(param(req.params.id))
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getBookingsByClient = async (req: Request, res: Response) => {
  try {
    const bookings = await getBookingsByClientService(param(req.params.clientId))
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
    const booking = await createBookingService(req.body, userId, ip)
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
    const booking = await updateBookingService(param(req.params.id), req.body, userId, ip)
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
    const booking = await updateBookingStatusService(param(req.params.id), req.body.status, userId, ip)
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
    await deleteBookingService(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Booking deleted successfully' })
  } catch (error: any) {
    const isNotFound   = error.message.includes('not found')
    const isBadRequest = error.message.includes("Cannot delete")
    res.status(isNotFound ? 404 : isBadRequest ? 400 : 500).json({ status: 'error', message: error.message })
  }
}

export const accountingReview = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await accountingReviewService(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : error.message.includes('already been') ? 409 : 500
    res.status(status).json({ status: 'error', message: error.message })
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
      : error.message.includes('must be') ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const opsAssign = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await opsAssignService(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already been') ? 409
      : error.message.includes('must be') ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const fleetApprove = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await fleetApproveService(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
      : error.message.includes('already been') ? 409
      : error.message.includes('must be') ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getDestinationsByBooking = async (req: Request, res: Response) => {
  try {
    const destinations = await getDestinationsByBookingService(param(req.params.id))
    res.status(200).json({ status: 'success', data: destinations })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateDestination = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const destination = await updateDestinationService(param(req.params.destinationId), req.body, userId, ip)
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
    const destination    = await updateDestinationStatusService(param(req.params.destinationId), status, deliveredAt, userId, ip)
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

export const driverConfirmPickup = async (req: Request, res: Response) => {
  try {
    const booking = await driverConfirmPickupService(
      param(req.params.bookingId),
      req.body.proof_photo_url,
      driverActor(req),
    )
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    res.status(driverProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

export const driverConfirmDelivery = async (req: Request, res: Response) => {
  try {
    const destination = await driverConfirmDeliveryService(
      param(req.params.bookingId),
      param(req.params.destinationId),
      req.body.proof_photo_url,
      driverActor(req),
    )
    res.status(200).json({ status: 'success', data: destination })
  } catch (error: any) {
    res.status(driverProgressStatus(error.message)).json({ status: 'error', message: error.message })
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
    await deleteDestinationService(param(req.params.destinationId), userId, ip)
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