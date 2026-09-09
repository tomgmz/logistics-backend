import { Request, Response } from 'express'
import {
  getTripsService,
  setTripPlanService,
  driverConfirmTripPickupService,
  driverConfirmTripStopService,
  driverConfirmFleetReturnService,
  attachStopProofService,
} from '../../services/client/trip.service.js'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import {
  StopTooFarError,
  STOP_PROOF_RADIUS_M,
  type StopProofPosition,
} from '../../lib/stop-geofence.js'

/**
 * Multi-trip driver progress.
 *
 * These sit alongside the single-trip confirmations in booking.controller rather
 * than replacing them: an app build in a driver's pocket still speaks the old
 * routes, and a delivery half-finished against them must be able to finish.
 */

function driverActor(req: Request) {
  const { userId, ip } = getRequestMeta(req)
  return { userId, ip, role: req.user?.role ?? null }
}

/**
 * 403 when the caller isn't the assigned driver, 404 for a missing trip or stop,
 * 409 when a run is loaded or unloaded out of order, 500 otherwise. The offline
 * queue keys its retry behaviour off exactly these codes, so an out-of-order
 * confirmation MUST be a 409 — anything else and a queued delivery is dropped.
 */
function tripProgressStatus(message: string): number {
  if (message.includes('not assigned'))    return 403
  if (message.includes('not found'))       return 404
  if (
    message.includes('Cannot ')        ||
    message.includes('Confirm the ')   ||
    message.includes('Finish trip')    ||
    message.includes('was cancelled')  ||
    message.includes('no longer on')
  ) return 409
  return 500
}

/** The position the app captured at the moment the driver confirmed. */
function stopProofPosition(req: Request): StopProofPosition | null {
  const { latitude, longitude, accuracy_m, override_reason } = req.body ?? {}
  const hasFix = typeof latitude === 'number' && typeof longitude === 'number'

  if (!hasFix) {
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

/** Too far from the stop is a 422 carrying the distance, not a generic error. */
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
  res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
}

export const getTrips = async (req: Request, res: Response) => {
  try {
    const trips = await getTripsService(param(req.params.bookingId), driverActor(req))
    res.status(200).json({ status: 'success', data: trips })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

export const setTripPlan = async (req: Request, res: Response) => {
  try {
    const trips = await setTripPlanService(
      param(req.params.bookingId),
      req.body.trips ?? [],
      driverActor(req),
    )
    res.status(200).json({ status: 'success', data: trips })
  } catch (error: any) {
    const status =
      error.message.includes('not allowed')     ? 403 :
      error.message.includes('not found')      ? 404 :
      error.message.includes('already started') ? 409 :
      error.message.includes('not on this booking') ||
      error.message.includes('must serve')      ||
      error.message.includes('must be served')  ||
      error.message.includes('at least one')    ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const driverConfirmTripPickup = async (req: Request, res: Response) => {
  try {
    const trip = await driverConfirmTripPickupService(
      param(req.params.tripId),
      req.body.proof_photo_url,
      driverActor(req),
      req.body.early_start === true,
      stopProofPosition(req),
    )
    res.status(200).json({ status: 'success', data: trip })
  } catch (error: any) {
    stopProofFailure(res, error)
  }
}

export const driverConfirmTripStop = async (req: Request, res: Response) => {
  try {
    const stop = await driverConfirmTripStopService(
      param(req.params.tripStopId),
      req.body.proof_photo_url,
      driverActor(req),
      stopProofPosition(req),
    )
    res.status(200).json({ status: 'success', data: stop })
  } catch (error: any) {
    stopProofFailure(res, error)
  }
}

export const attachStopProof = async (req: Request, res: Response) => {
  try {
    const stop = await attachStopProofService(
      param(req.params.tripStopId),
      req.body.proof_photo_url,
      driverActor(req),
    )
    res.status(200).json({ status: 'success', data: stop })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

export const driverConfirmFleetReturn = async (req: Request, res: Response) => {
  try {
    const booking = await driverConfirmFleetReturnService(
      param(req.params.bookingId),
      driverActor(req),
      stopProofPosition(req),
    )
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}
