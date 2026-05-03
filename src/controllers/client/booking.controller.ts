import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import {
  getAllBookingsService,
  getAllBookingsPaginatedService,
  getBookingByIdService,
  getBookingsByClientService,
  createBookingService,
  updateBookingService,
  updateBookingStatusService,
  deleteBookingService,
  getDestinationsByBookingService,
  updateDestinationService,
  updateDestinationStatusService,
  deleteDestinationService,
  getBookingsByDriverService,
} from '../../services/client/booking.service.js'

export const getAllBookings = async (req: Request, res: Response) => {
  try {
    const pageRaw  = req.query.page
    const limitRaw = req.query.limit
    const page     = pageRaw != null && pageRaw !== '' ? parseInt(String(pageRaw), 10) : NaN
    const limit    = limitRaw != null && limitRaw !== '' ? parseInt(String(limitRaw), 10) : NaN

    if (Number.isFinite(page) && Number.isFinite(limit) && limit > 0 && page > 0) {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all'
      const search = typeof req.query.search === 'string' ? req.query.search : ''
      const result   = await getAllBookingsPaginatedService({ page, limit, status, search })
      return res.status(200).json({
        status: 'success',
        data:   result.data,
        meta:   result.meta,
      })
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

export const createBooking = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    const booking = await createBookingService(req.body, userId, ip)
    res.status(201).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = (
      error.message.includes('required') ||
      error.message.includes('scheduled at least') ||
      error.message.includes('more than 1 year')
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
    const status = (
      error.message.includes('not found')
        ? 404
        : error.message.includes('scheduled at least') || error.message.includes('more than 1 year')
          ? 400
          : 500
    )
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
    const status = isNotFound ? 404 : isBadRequest ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const deleteBooking = async (req: Request, res: Response) => {
  try {
    const { userId, ip } = getRequestMeta(req)
    await deleteBookingService(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Booking deleted successfully' })
  } catch (error: any) {
    const isNotFound   = error.message.includes('not found')
    const isBadRequest = error.message.includes('in transit')
    const status = isNotFound ? 404 : isBadRequest ? 400 : 500
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

export const getBookingsByDriver = async (req: Request, res: Response) => {
  try {
    const bookings = await getBookingsByDriverService(param(req.params.driverId))
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}