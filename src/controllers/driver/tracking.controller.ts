import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import {
  recordDriverPositionService,
  getLivePositionService,
} from '../../services/driver/tracking.service.js'

/**
 * Live position ingest and read-back.
 *
 * The ingest side answers fast and quietly on purpose — see the note on the 202
 * below. It is the highest-frequency route in the system and the app has no
 * useful reaction to any answer it gets.
 */

function driverActor(req: Request) {
  const { userId, ip } = getRequestMeta(req)
  return { userId, ip, role: req.user?.role ?? null }
}

export const recordDriverPosition = async (req: Request, res: Response) => {
  try {
    const position = await recordDriverPositionService(
      param(req.params.bookingId),
      {
        latitude:    req.body.latitude,
        longitude:   req.body.longitude,
        accuracy_m:  req.body.accuracy_m,
        speed_mps:   req.body.speed_mps,
        heading_deg: req.body.heading_deg,
        recorded_at: req.body.recorded_at,
      },
      driverActor(req),
    )

    // 202 means "understood, not recorded": the booking isn't running, or the
    // fix was too old to draw. Neither is the app's fault and neither is worth a
    // 4xx — an error here would push the device towards retrying a ping, which
    // is the one thing a position must never do.
    if (!position) return res.status(202).json({ status: 'success', data: null })

    res.status(200).json({ status: 'success', data: position })
  } catch (error: any) {
    const message = String(error?.message ?? '')
    const httpStatus =
      message.includes('not assigned') ? 403 :
      message.includes('not found')    ? 404 : 500
    res.status(httpStatus).json({ status: 'error', message })
  }
}

export const getLivePosition = async (req: Request, res: Response) => {
  try {
    const position = await getLivePositionService(param(req.params.id), {
      role:     req.user?.role ?? 'client',
      clientId: req.clientId ?? null,
    })
    // Null is an ordinary answer, not a 404: the booking exists, the truck just
    // hasn't reported yet. The map renders "position unavailable" for it.
    res.status(200).json({ status: 'success', data: position })
  } catch (error: any) {
    const httpStatus = String(error?.message ?? '').includes('not found') ? 404 : 500
    res.status(httpStatus).json({ status: 'error', message: error.message })
  }
}
