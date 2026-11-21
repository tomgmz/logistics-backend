import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import {
  claimNavigationService,
  getNavigationService,
  releaseNavigationService,
  NavigationHeldError,
} from '../../services/driver/navigation.service.js'

function driverActor(req: Request) {
  const { userId } = getRequestMeta(req)
  return { userId, role: req.user?.role ?? null }
}

function statusOf(message: string): number {
  return message.includes('not found') ? 404
    : message.includes('not assigned') ? 403
    : message.startsWith('Cannot') ? 409
    : 500
}

/** Who is navigating this booking. The booking's own crew only. */
export async function getNavigation(req: Request, res: Response) {
  try {
    const data = await getNavigationService(param(req.params.bookingId), driverActor(req))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error.message)).json({ status: 'error', message: error.message })
  }
}

/**
 * This phone starts navigating. 409 `navigation_held` (with who holds it) when
 * the other driver's phone is navigating and `take_over` was not sent.
 */
export async function claimNavigation(req: Request, res: Response) {
  try {
    const data = await claimNavigationService(param(req.params.bookingId), driverActor(req), req.body?.take_over === true)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    if (error instanceof NavigationHeldError) {
      res.status(409).json({ status: 'error', code: 'navigation_held', message: error.message, data: error.state })
      return
    }
    res.status(statusOf(error.message)).json({ status: 'error', message: error.message })
  }
}

/** This phone ended navigation. */
export async function releaseNavigation(req: Request, res: Response) {
  try {
    const data = await releaseNavigationService(param(req.params.bookingId), driverActor(req))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(statusOf(error.message)).json({ status: 'error', message: error.message })
  }
}
