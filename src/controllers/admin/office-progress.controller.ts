import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import {
  officeConfirmPickupService,
  officeConfirmStopService,
  officeConfirmFleetReturnService,
  officeReportIncidentService,
} from '../../services/admin/office-progress.service.js'
import {
  acceptLateConfirmation,
  deliveryEvents,
  dismissLateConfirmation,
  listLateConfirmations,
  swapPreview,
} from '../../services/admin/late-confirmation-office.service.js'

/** 404 missing, 409 out of order / wrong state (the same words the driver flow uses), 500 otherwise. */
function statusFor(message: string): number {
  if (message.includes('not found')) return 404
  if (message.includes('invalid input syntax for type uuid')) return 400
  if (message.includes('Say why')) return 400
  if (
    message.includes('Cannot ')       ||
    message.includes('Confirm ')      ||
    message.includes('Finish trip')   ||
    message.includes('was cancelled') ||
    message.includes('no longer on')  ||
    message.includes('taken out of service')
  ) return 409
  return 500
}

function run(fn: (req: Request, userId: string | null | undefined, role: string | null) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const { userId } = getRequestMeta(req)
      const data = await fn(req, userId, req.user?.role ?? null)
      res.status(200).json({ status: 'success', data })
    } catch (error: any) {
      res.status(statusFor(String(error?.message ?? ''))).json({ status: 'error', message: error.message })
    }
  }
}

export const confirmPickup = run((req, userId, role) =>
  officeConfirmPickupService(param(req.params.bookingId), param(req.params.tripId), req.body.reason, userId, role))

export const confirmStop = run((req, userId, role) =>
  officeConfirmStopService(param(req.params.bookingId), param(req.params.tripStopId), req.body.reason, userId, role))

export const confirmFleetReturn = run((req, userId, role) =>
  officeConfirmFleetReturnService(param(req.params.bookingId), req.body.reason, userId, role))

export const reportIncident = run((req, userId, role) =>
  officeReportIncidentService(param(req.params.bookingId), req.body, userId, role))

// Late drop-off confirmations (after a driver swap), the swap dialog's data, and
// one list of what happened on the road (late-confirmation-office.service).
export const listLate = run((req) => listLateConfirmations(param(req.params.bookingId)))

export const acceptLate = run((req, userId) =>
  acceptLateConfirmation(param(req.params.bookingId), param(req.params.lateId), req.body?.note ?? null, userId ?? null))

export const dismissLate = run((req, userId) =>
  dismissLateConfirmation(param(req.params.bookingId), param(req.params.lateId), req.body?.reason ?? '', userId ?? null))

export const getSwapPreview = run((req) => swapPreview(param(req.params.bookingId)))

export const getEvents = run((req) => deliveryEvents(param(req.params.bookingId)))
