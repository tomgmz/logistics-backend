import { Request, Response } from 'express'
import {
  geocodeAddressService,
  optimizeBookingRouteService,
  getOptimizedRouteService,
} from '../../services/maps/routeOptimization.service.js'
import { assertBookingVisible } from '../../services/client/booking.service.js'

/**
 * Both route reads below authorize the `client` role, and neither used to look at
 * WHICH client was asking — so any signed-in client could read another company's
 * pickup address and every drop-off coordinate by putting their booking id in the
 * URL. `authorize` settles what role you are; it says nothing about what company
 * you belong to, exactly as the note on the booking routes explains.
 *
 * The check lives in the controller rather than the service because
 * booking.service already imports this service (`optimizeDestinationsService`),
 * so asserting from inside would close an import cycle.
 */
function viewerFrom(req: Request) {
  return { role: req.user?.role ?? 'client', clientId: req.clientId ?? null }
}

export const getOptimizedRoute = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params
    await assertBookingVisible(bookingId as string, viewerFrom(req))
    const result = await getOptimizedRouteService(bookingId as string)
    res.status(200).json({ status: 'success', data: result })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Something went wrong'
    const status = message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message })
  }
}

export const optimizeBookingRoute = async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    await assertBookingVisible(id as string, viewerFrom(req))
    const result = await optimizeBookingRouteService(id as string)
    res.status(200).json({ status: 'success', data: result })
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { data?: unknown } }
    console.error('Optimization error:', err.response?.data ?? err.message)
    const message = err.message ?? 'Something went wrong'
    const isNotFound   = message.includes('not found')
    const isBadRequest = message.includes('no destinations') || message.includes('Cannot optimize')
    const httpStatus   = isNotFound ? 404 : isBadRequest ? 400 : 500
    res.status(httpStatus).json({ status: 'error', message, details: err.response?.data })
  }
}

export const geocodeAddress = async (req: Request, res: Response) => {
  try {
    const { address } = req.body
    const result = await geocodeAddressService(address as string)
    res.status(200).json({ status: 'success', data: result })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Something went wrong'
    res.status(500).json({ status: 'error', message })
  }
}