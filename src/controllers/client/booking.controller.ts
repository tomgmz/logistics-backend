import { Request, Response } from 'express'
import {
  getAllBookingsService,
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

//Bookings

export const getAllBookings = async (req: Request, res: Response) => {
  try {
    const bookings = await getAllBookingsService()
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const getBookingById = async (req: Request, res: Response) => {
  try {
    const booking = await getBookingByIdService(req.params.id as string)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getBookingsByClient = async (req: Request, res: Response) => {
  try {
    const bookings = await getBookingsByClientService(req.params.clientId as string)
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const createBooking = async (req: Request, res: Response) => {
  try {
    const booking = await createBookingService(req.body)
    res.status(201).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('required') ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateBooking = async (req: Request, res: Response) => {
  try {
    const booking = await updateBookingService(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateBookingStatus = async (req: Request, res: Response) => {
  try {
    const booking = await updateBookingStatusService(req.params.id as string, req.body.status)
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    const isNotFound = error.message.includes('not found')
    const isBadRequest = error.message.includes('Cannot change status')
    const status = isNotFound ? 404 : isBadRequest ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const deleteBooking = async (req: Request, res: Response) => {
  try {
    await deleteBookingService(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Booking deleted successfully' })
  } catch (error: any) {
    const isNotFound = error.message.includes('not found')
    const isBadRequest = error.message.includes('in transit')
    const status = isNotFound ? 404 : isBadRequest ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

//Booking destination

export const getDestinationsByBooking = async (req: Request, res: Response) => {
  try {
    const destinations = await getDestinationsByBookingService(req.params.id as string)
    res.status(200).json({ status: 'success', data: destinations })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateDestination = async (req: Request, res: Response) => {
  try {
    const destination = await updateDestinationService(req.params.destinationId as string, req.body)
    res.status(200).json({ status: 'success', data: destination })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const updateDestinationStatus = async (req: Request, res: Response) => {
  try {
    const { status, delivered_at } = req.body
    const destination = await updateDestinationStatusService(req.params.destinationId as string, status, delivered_at)
    res.status(200).json({ status: 'success', data: destination })
  } catch (error: any) {
    const httpStatus = error.message.includes('not found') ? 404 : 500
    res.status(httpStatus).json({ status: 'error', message: error.message })
  }
}

export const deleteDestination = async (req: Request, res: Response) => {
  try {
    await deleteDestinationService(req.params.destinationId as string)
    res.status(200).json({ status: 'success', message: 'Destination deleted successfully' })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const getBookingsByDriver = async (req: Request, res: Response) => {
  try {
    const bookings = await getBookingsByDriverService(req.params.driverId as string)
    res.status(200).json({ status: 'success', data: bookings })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}
 
