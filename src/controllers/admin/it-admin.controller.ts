import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as ITAdminService from '../../services/admin/it-admin.service.js'

export async function getAllITAdmins(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await ITAdminService.getAllITAdmins(userId)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getITAdminById(req: Request, res: Response) {
  try {
    const data = await ITAdminService.getITAdminById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'IT Administrator not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

// Codes the service raises for rule violations rather than failures — each is a
// deliberate refusal the caller can act on, not a server problem.
const CONFLICT_CODES = new Set([
  'IT_ADMIN_EXISTS',
  'LAST_IT_ADMIN',
  'IT_ADMIN_SELF_ACTION',
  'NO_ACTIVE_IT_ADMIN',
  'MULTIPLE_ACTIVE_IT_ADMINS',
])

/**
 * 409 for a rule violation, 500 for anything else.
 *
 * `users_one_active_it_admin` is included because the service pre-check can lose
 * a race with a concurrent create — the index is the real guarantee, and a caller
 * who hits it deserves the same answer as one who hit the pre-check.
 */
function statusForError(err: any): number {
  if (CONFLICT_CODES.has(err?.code)) return 409
  if (typeof err?.message === 'string' && err.message.includes('users_one_active_it_admin')) return 409
  return 500
}

export async function createITAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await ITAdminService.createITAdmin(req.body, userId)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(statusForError(err)).json({ status: 'error', code: err.code, message: err.message })
  }
}

/** The caller's place in a handover: seat holder, or rendering until a date. */
export async function getHandoverStatus(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await ITAdminService.getHandoverStatus(userId!)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

/**
 * The IT Admin hands their role to a successor.
 *
 * The outgoing account is the caller — never named in the request — so a stale
 * id sitting in a form cannot hand over someone else's seat.
 */
export async function transitionITAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await ITAdminService.transitionITAdmin(req.body, userId)
    res.status(201).json({
      status:  'success',
      message: `IT Administrator role handed over. Your account stays active for ${ITAdminService.RENDER_DAYS} days.`,
      data,
    })
  } catch (err: any) {
    console.error('IT ADMIN TRANSITION ERROR:', err)
    const status = err?.code === 'NOT_SEAT_HOLDER' ? 403 : statusForError(err)
    res.status(status).json({ status: 'error', code: err.code, message: err.message })
  }
}

export async function updateITAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await ITAdminService.updateITAdmin(param(req.params.id), req.body, userId)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteITAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    await ITAdminService.deleteITAdmin(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'IT Administrator deleted successfully' })
  } catch (err: any) {
    res.status(statusForError(err)).json({ status: 'error', code: err.code, message: err.message })
  }
}

export async function deactivateITAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await ITAdminService.deactivateITAdmin(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'IT Administrator deactivated', data })
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') ? 409
      : statusForError(err)
    res.status(status).json({ status: 'error', code: err.code, message: err.message })
  }
}

export async function activateITAdmin(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await ITAdminService.activateITAdmin(param(req.params.id), userId)
    res.status(200).json({ status: 'success', message: 'IT Administrator activated', data })
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') ? 409
      : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}