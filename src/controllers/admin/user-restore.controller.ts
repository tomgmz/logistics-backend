import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { restoreArchivedUser, type BanManagedUserRole } from '../../services/admin/user-auth-status.service.js'

/**
 * POST /<role path>/:id/restore — bring an archived account back as active.
 * One handler per role, so a restore through /clients can never touch a staff
 * account (the service matches the id AND the role).
 */
function restoreHandler(role: BanManagedUserRole, label: string, action: string) {
  return async (req: Request, res: Response) => {
    try {
      const { userId } = getRequestMeta(req)
      const data = await restoreArchivedUser(param(req.params.id), role, action, label, userId)
      res.status(200).json({ status: 'success', message: `${label} restored`, data })
    } catch (err: any) {
      const status = err.message.includes('not found') ? 404
        : err.message.includes('not archived') || err.message.includes('Only one IT Administrator') ? 409
        : 500
      res.status(status).json({ status: 'error', message: err.message })
    }
  }
}

export const restoreClient          = restoreHandler('client',             'Client',                'client_restored')
export const restoreDriver          = restoreHandler('driver',             'Driver',                'driver_restored')
export const restoreAdmin           = restoreHandler('admin',              'Company Administrator', 'admin_restored')
export const restoreGeneralManager  = restoreHandler('general_manager',    'General Manager',       'general_manager_restored')
export const restoreFleetManager    = restoreHandler('fleet_manager',      'Fleet Manager',         'fleet_manager_restored')
export const restoreOperationsAdmin = restoreHandler('operations_manager', 'Operations Manager',    'operations_manager_restored')
export const restoreITAdmin         = restoreHandler('it_admin',           'IT Administrator',      'it_admin_restored')
