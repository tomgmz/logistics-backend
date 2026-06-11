import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as PermissionsService from '../../services/admin/permissions.service.js'

export async function getUserPermissions(req: Request, res: Response) {
  try {
    const data = await PermissionsService.getUserPermissions(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'User not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function setUserPermissions(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await PermissionsService.setUserPermissions(
      param(req.params.id),
      req.body.permissions,
      userId,
    )
    res.status(200).json({ status: 'success', message: 'Permissions updated', data })
  } catch (err: any) {
    const msg = err.message ?? 'Error'
    const status = msg === 'User not found' ? 404
      : msg.startsWith('protected:') ? 403
      : msg.includes('managed staff') ? 422
      : 500
    res.status(status).json({ status: 'error', message: msg.replace(/^protected:\s*/, '') })
  }
}
