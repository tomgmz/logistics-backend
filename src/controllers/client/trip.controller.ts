import { Request, Response } from 'express'
import {
  driverSetStopOrderService,
  getTripsService,
  setTripPlanService,
  setDriverCallTimeService,
  driverConfirmTripPickupService,
  driverConfirmTripStopService,
  driverConfirmFleetReturnService,
  attachStopProofService,
  resolveTripByNumber,
  resolveTripStopByDestination,
  PlanQuantityError,
} from '../../services/client/trip.service.js'
import {
  staffPauseTripService,
  staffResumeTripService,
  listPausesService,
} from '../../services/client/pause.service.js'
import { driverStartDeliveryService } from '../../services/driver/start-delivery.service.js'
import { driverRecordMilestoneService, staffSetMilestoneService, bookingTimeline } from '../../services/client/milestone.service.js'
import { driverConfirmLoadTransferService, driverPendingLoadTransferService } from '../../services/admin/crew-replacement.service.js'
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
  const { userId } = getRequestMeta(req)
  return { userId, role: req.user?.role ?? null }
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
  // A malformed id in the URL reaches Postgres as an invalid uuid. That is the
  // caller's mistake, not ours: 400, not 500.
  if (message.includes('invalid input syntax for type uuid')) return 400
  if (
    message.includes('Cannot ')        ||
    message.includes('Confirm the ')   ||
    message.includes('Finish trip')    ||
    message.includes('was cancelled')  ||
    message.includes('no longer on')   ||
    message.includes('taken out of service')
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

export const setDriverCallTime = async (req: Request, res: Response) => {
  try {
    const data = await setDriverCallTimeService(
      param(req.params.bookingId),
      req.body.driver_call_time ?? null,
      driverActor(req),
    )
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status =
      error.message.includes('not found') ? 404 :
      error.message.includes('Cannot ')   ? 409 : 500
    res.status(status).json({ status: 'error', message: error.message })
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
      error instanceof PlanQuantityError        ? 400 :
      error.message.includes('not allowed')     ? 403 :
      error.message.includes('not found')      ? 404 :
      error.message.includes('already started') ? 409 :
      error.message.includes('not on this booking') ||
      error.message.includes('must serve')      ||
      error.message.includes('must be served')  ||
      error.message.includes('must say how much') ||
      error.message.includes('must match')      ||
      error.message.includes('more than 10')    ||
      error.message.includes('at least one')    ? 400 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export const driverConfirmTripPickup = async (req: Request, res: Response) => {
  try {
    // A trip the phone added offline (cargo rolled over to a new last trip) has
    // no id it knows of yet; it names the trip by booking + number instead.
    const tripId = req.params.tripNumber
      ? await resolveTripByNumber(param(req.params.bookingId), Number(req.params.tripNumber))
      : param(req.params.tripId)
    const trip = await driverConfirmTripPickupService(
      tripId,
      req.body.proof_photo_url,
      driverActor(req),
      req.body.early_start === true,
      stopProofPosition(req),
      req.body.loaded,
    )
    res.status(200).json({ status: 'success', data: trip })
  } catch (error: any) {
    stopProofFailure(res, error)
  }
}

/**
 * Start (or Resume) Navigation. 403 when the caller is no longer on the crew —
 * the office re-assigned the booking — so the phone stops and re-reads; 409 when
 * the booking cannot start (cancelled, vehicle pulled, before its day).
 */
export const driverStartDelivery = async (req: Request, res: Response) => {
  try {
    const { booking, started } = await driverStartDeliveryService(
      param(req.params.bookingId),
      driverActor(req),
      req.body?.early_start === true,
    )
    res.status(200).json({ status: 'success', data: { booking, started } })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

/** A step at a stop: arrived at parking, docked, started, departed. */
export const driverRecordMilestone = async (req: Request, res: Response) => {
  try {
    const data = await driverRecordMilestoneService(param(req.params.bookingId), req.body ?? {}, driverActor(req))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

/** After a crew replacement: what the load transfer needs, or null. */
export const getLoadTransfer = async (req: Request, res: Response) => {
  try {
    const data = await driverPendingLoadTransferService(param(req.params.bookingId), driverActor(req))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

/** The new driver moved the load onto their vehicle, with a photo. */
export const driverConfirmLoadTransfer = async (req: Request, res: Response) => {
  try {
    const data = await driverConfirmLoadTransferService(
      param(req.params.bookingId),
      req.body.proof_photo_url,
      driverActor(req),
      stopProofPosition(req),
    )
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    stopProofFailure(res, error)
  }
}

export const driverConfirmTripStop = async (req: Request, res: Response) => {
  try {
    // Likewise a stop the phone added offline: booking + trip number + drop-off.
    const tripStopId = req.params.tripNumber
      ? await resolveTripStopByDestination(
          param(req.params.bookingId), Number(req.params.tripNumber), param(req.params.destinationId))
      : param(req.params.tripStopId)
    const stop = await driverConfirmTripStopService(
      tripStopId,
      req.body.proof_photo_url,
      driverActor(req),
      stopProofPosition(req),
    )
    res.status(200).json({ status: 'success', data: stop })
  } catch (error: any) {
    stopProofFailure(res, error)
  }
}

export const driverSetStopOrder = async (req: Request, res: Response) => {
  try {
    const trip = await driverSetStopOrderService(
      param(req.params.tripId),
      req.body.trip_stop_ids,
      driverActor(req),
    )
    res.status(200).json({ status: 'success', data: trip })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
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

/* ── Pausing a delivery ───────────────────────────────────────────────────── */

/** 403 for the wrong person, 404 for a missing booking, 409 for a booking that can't be paused. */
function pauseStatus(message: string): number {
  if (message.includes('not assigned') || message.includes('not allowed') || message.includes('Only the main driver')) return 403
  if (message.includes('not found'))  return 404
  if (message.includes('invalid input syntax for type uuid')) return 400
  if (message.includes('Cannot '))    return 409
  return 500
}

/**
 * The driver app's old Pause / Resume. Pausing is the office's call now. 410,
 * not 403: an older app's offline queue drops a 410 but holds the whole queue
 * behind a 403, which would stall the stop confirmations queued after it.
 */
export const driverPauseRetired = (_req: Request, res: Response) => {
  res.status(410).json({
    status: 'error',
    message: 'Only Operations or the Company Administrator can pause or resume a delivery. Call the office.',
  })
}

export const staffPauseTrip = async (req: Request, res: Response) => {
  try {
    const booking = await staffPauseTripService(param(req.params.bookingId), req.body, driverActor(req))
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    res.status(pauseStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

export const staffResumeTrip = async (req: Request, res: Response) => {
  try {
    const booking = await staffResumeTripService(
      param(req.params.bookingId),
      driverActor(req),
      req.body?.note ?? null,
    )
    res.status(200).json({ status: 'success', data: booking })
  } catch (error: any) {
    res.status(pauseStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

export const listPauses = async (req: Request, res: Response) => {
  try {
    const pauses = await listPausesService(param(req.params.bookingId))
    res.status(200).json({ status: 'success', data: pauses })
  } catch (error: any) {
    res.status(pauseStatus(error.message)).json({ status: 'error', message: error.message })
  }
}

/** Staff: the stop times with correction notes. */
export const staffGetTimeline = async (req: Request, res: Response) => {
  try {
    res.status(200).json({ status: 'success', data: await bookingTimeline(param(req.params.bookingId), { withNotes: true }) })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

/** Staff: fill in or correct one stop time, with a reason. */
export const staffSetMilestone = async (req: Request, res: Response) => {
  try {
    const { userId } = getRequestMeta(req)
    const data = await staffSetMilestoneService(param(req.params.bookingId), req.body, { userId })
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(tripProgressStatus(error.message)).json({ status: 'error', message: error.message })
  }
}
