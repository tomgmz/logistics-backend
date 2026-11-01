import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { driverSeatOnBooking } from '../../services/client/booking.service.js'
import {
  driverTakeWheelService,
  listShifts,
  staffSwapCrewRolesService,
} from '../../services/driver/driving-shift.service.js'

function driverActor(req: Request) {
  const { userId } = getRequestMeta(req)
  return { userId, role: req.user?.role ?? null }
}

// The app's offline queue retries a 409 a few times, then drops it; a 403
// "not assigned" is dropped at once (the driver is off the booking).
function statusOf(message: string): number {
  return message.includes('not found') ? 404
    : message.includes('not assigned') ? 403
    : message.startsWith('Cannot') || message.includes('only be swapped') || message.includes('no second driver') || message.startsWith('Say why') ? 409
    : 500
}

/** A crew member took the wheel (the app's "I'm taking the wheel"). */
export async function driverTakeWheel(req: Request, res: Response) {
  try {
    const data = await driverTakeWheelService(param(req.params.bookingId), req.body ?? {}, driverActor(req))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error.message)).json({ status: 'error', message: error.message })
  }
}

/** Who has driven, and who is driving now. Staff, and the booking's own crew. */
export async function getShifts(req: Request, res: Response) {
  try {
    const bookingId = param(req.params.bookingId)
    // A driver reads only a booking they are crewed on (throws "not assigned").
    if (req.user?.role === 'driver') await driverSeatOnBooking(bookingId, driverActor(req))
    res.status(200).json({ status: 'success', data: await listShifts(bookingId) })
  } catch (error: any) {
    res.status(statusOf(error.message)).json({ status: 'error', message: error.message })
  }
}

/** The office swaps the main and second driver on the road. */
export async function staffSwapCrewRoles(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await staffSwapCrewRolesService(param(req.params.bookingId), String(req.body?.reason ?? ''), userId ?? null)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error.message)).json({ status: 'error', message: error.message })
  }
}
