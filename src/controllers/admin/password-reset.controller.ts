import { Request, Response } from 'express'
import { param } from '../../lib/controller-utils.js'
import * as ResetService from '../../services/auth/password-reset.service.js'
import { ResetRequestStatus } from '../../types/password-reset.types.js'
import { pageQuery, paginate, searchQuery, matchesWords, queryString } from '../../lib/paginate.js'
import { matchesFilter, parseFilterRules } from '../../lib/filter-rules.js'
import { phDay } from '../../lib/ph-date.js'

// The queue's "Requested" dropdown.
const REQUESTED_WINDOW_DAYS: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30 }

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

    const paging = pageQuery(req)
    if (paging) {
      // The reset queue table: filters, search and the pending count are
      // worked out here, and only the page on screen goes back.
      const rules  = parseFilterRules(req.query.filters)
      const days   = REQUESTED_WINDOW_DAYS[rules.find((r) => r.field === 'requested')?.value ?? '']
      const since  = days ? Date.now() - days * 86_400_000 : null
      const from   = queryString(req, 'from')
      const to     = queryString(req, 'to')
      const q      = searchQuery(req)
      const rows   = data.filter((r: any) => {
        const day = phDay(new Date(r.created_at))
        return matchesFilter(rules, 'status', r.status) &&
          matchesFilter(rules, 'role', r.requested_role) &&
          (since === null || new Date(r.created_at).getTime() >= since) &&
          (!from || day >= from) && (!to || day <= to) &&
          matchesWords(q, [[r.first_name, r.last_name].filter(Boolean).join(' '), r.email])
      })
      // Anything an admin still has to act on, over the whole queue.
      const pendingCount = data.filter((r: any) => r.status === 'pending' || r.status === 'expired').length
      const { data: page, meta } = paginate(rows, paging)
      return res.status(200).json({ status: 'success', data: page, meta: { ...meta, unfiltered: data.length, pendingCount } })
    }

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
