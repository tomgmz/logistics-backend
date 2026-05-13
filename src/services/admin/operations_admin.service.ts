import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import * as OperationsAdminModel from '../../models/admin/operations_admin.model.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'

interface UpdateOperationsAdminDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
  email?: string
  phone?: string | null
}

export async function getAllOperationsAdmins() {
  return OperationsAdminModel.findAll()
}

export async function getOperationsAdminById(userId: string) {
  const opsAdmin = await OperationsAdminModel.findById(userId)
  if (!opsAdmin) throw new Error('Operations Admin not found')
  return opsAdmin
}

export async function createOperationsAdmin(dto: BaseCreateDTO, actorId?: string | null, ip?: string | null) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'operations_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await OperationsAdminModel.create(userId, dto)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'operations_admin_created',
      description: `Operations Admin ${dto.email} created (user: ${userId})`,
      ip_address:  ip,
    })

    return result
  } catch (err: any) {
    console.error('Operations Admin creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Operations Admin Creation Failed: ${err.message}`)
  }
}

export async function updateOperationsAdmin(userId: string, dto: UpdateOperationsAdminDTO, actorId?: string | null, ip?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: dto.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await OperationsAdminModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'operations_admin_updated',
    description: `Operations Admin ${userId} updated`,
    ip_address:  ip,
  })

  return result
}

export async function deleteOperationsAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await OperationsAdminModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'operations_admin_deleted',
    description: `Operations Admin ${userId} deleted`,
    ip_address:  ip,
  })

  return result
}

export async function deactivateOperationsAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'operations_admin', 'operations_admin_deactivated', 'Operations Admin', actorId, ip)
}

export async function activateOperationsAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'operations_admin', 'operations_admin_activated', 'Operations Admin', actorId, ip)
}