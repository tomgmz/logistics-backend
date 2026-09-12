import { Request, Response } from 'express'
import { param } from '../../lib/controller-utils.js'
import * as ResetService from '../../services/auth/password-reset.service.js'
import { ResetRequestStatus } from '../../types/password-reset.types.js'

const ALL_STATUSES: ResetRequestStatus[] = [
  'pending', 'sent', 'completed', 'cancelled', 'expired',
]

function actorFrom(req: Request): ResetService.ResetActor {
  return { user_id: req.user!.sub, role: req.user!.role }
}

/**
 * The caller's own queue. The group is derived from their role rather than taken
 * from a query param, so an admin cannot read the other admin's queue by asking.
 */
export async function listRequests(req: Request, res: Response) {
  try {
    const includeClosed = req.query.include_closed === 'true'
    const statuses: ResetRequestStatus[] = includeClosed
      ? ALL_STATUSES
      : ['pending', 'sent']

    const data = await ResetService.listRequestsForActor(actorFrom(req), statuses)
    res.status(200).json({ status: 'success', data })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load reset requests'
    console.error('LIST RESET REQUESTS ERROR:', err)
    res.status(500).json({ status: 'error', message })
  }
}

export async function sendLink(req: Request, res: Response) {
  try {
    const data = await ResetService.sendResetLink(param(req.params.id), actorFrom(req))
    res.status(200).json({ status: 'success', message: 'Reset link sent.', data })
  } catch (err: unknown) {
    const code    = (err as any)?.code
    const message = err instanceof Error ? err.message : 'Failed to send reset link'

    // Acting on the other admin's queue is a permission problem, not a bad request.
    if (code === 'RESET_WRONG_HANDLER') {
      res.status(403).json({ status: 'error', code, message })
      return
    }

    console.error('SEND RESET LINK ERROR:', err)
    res.status(400).json({ status: 'error', message })
  }
}

export async function cancelRequest(req: Request, res: Response) {
  try {
    const data = await ResetService.cancelRequest(param(req.params.id), actorFrom(req))
    res.status(200).json({ status: 'success', message: 'Request cancelled.', data })
  } catch (err: unknown) {
    const code    = (err as any)?.code
    const message = err instanceof Error ? err.message : 'Failed to cancel request'

    if (code === 'RESET_WRONG_HANDLER') {
      res.status(403).json({ status: 'error', code, message })
      return
    }

    console.error('CANCEL RESET REQUEST ERROR:', err)
    res.status(400).json({ status: 'error', message })
  }
}
