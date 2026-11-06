import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { logSystem } from '../../lib/log-system.js'

/** A device-reported silence longer than this goes to System Logs. */
const GAP_LOG_MS = 2 * 60 * 1000
import {
  recordDriverPositionService,
  getLivePositionService,
  getFleetPositionsService,
} from '../../services/driver/tracking.service.js'

/**
 * Live position ingest and read-back.
 *
 * The ingest side answers fast and quietly on purpose — see the note on the 202
 * below. It is the highest-frequency route in the system and the app has no
 * useful reaction to any answer it gets.
 */

function driverActor(req: Request) {
  const { userId } = getRequestMeta(req)
  return { userId, role: req.user?.role ?? null }
}

export const recordDriverPosition = async (req: Request, res: Response) => {
  try {
    const result = await recordDriverPositionService(
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

    // The phone was silent for a while: record why, so a hole in the trail has
    // a cause (no fixes from the OS = app stopped; offline; requests failing).
    const gap = req.body.gap as
      | { since_ms: number; fixes: number; offline: number; failed: number; last_error?: string | null; background?: boolean; restarted?: boolean }
      | undefined
    if (gap && gap.since_ms > GAP_LOG_MS) {
      const minutes = Math.round(gap.since_ms / 60_000)
      const cause =
        gap.fixes <= 1   ? 'the phone delivered no location fixes (app stopped or location paused by the OS)' :
        gap.offline > 0 && gap.failed === 0 ? 'the phone had no connection' :
        gap.failed > 0   ? `uploads failed (${gap.last_error ?? 'unknown error'})` :
                           'fixes were held back by the upload gates'
      logSystem({
        log_level:  'warn',
        event_type: 'external_api',
        source:     'tracking.device',
        message:    `Driver phone sent no position for ${minutes} min on booking ${param(req.params.bookingId)}: ${cause}.`,
        metadata:   { booking_id: param(req.params.bookingId), ...gap },
        user_id:    getRequestMeta(req).userId ?? null,
      })
    }

    // 202 means "understood, not recorded": the booking isn't running, or the
    // fix was too old to draw. Neither is the app's fault and neither is worth a
    // 4xx — an error here would push the device towards retrying a ping, which
    // is the one thing a position must never do. The reason travels with it
    // because only `booking_ended` should make the phone stop reporting.
    if (!result.recorded) {
      return res.status(202).json({ status: 'success', data: null, reason: result.reason })
    }

    res.status(200).json({ status: 'success', data: result.position })
  } catch (error: any) {
    const message = String(error?.message ?? '')
    const httpStatus =
      message.includes('not assigned') ? 403 :
      message.includes('not found')    ? 404 : 500
    res.status(httpStatus).json({ status: 'error', message })
  }
}

export const getFleetPositions = async (_req: Request, res: Response) => {
  try {
    res.status(200).json({ status: 'success', data: await getFleetPositionsService() })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export const getLivePosition = async (req: Request, res: Response) => {
  try {
    const position = await getLivePositionService(param(req.params.id), {
      role:     req.user?.role ?? 'client',
      clientId: req.clientId ?? null,
      driverId: req.driverId ?? null,
    })
    // Null is an ordinary answer, not a 404: the booking exists, the truck just
    // hasn't reported yet. The map renders "position unavailable" for it.
    res.status(200).json({ status: 'success', data: position })
  } catch (error: any) {
    const httpStatus = String(error?.message ?? '').includes('not found') ? 404 : 500
    res.status(httpStatus).json({ status: 'error', message: error.message })
  }
}
