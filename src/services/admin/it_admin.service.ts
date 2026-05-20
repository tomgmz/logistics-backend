import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import * as ITAdminModel from '../../models/admin/it_admin.model.js'
import { CreateITAdminInput, UpdateITAdminInput } from '../../types/it_admin.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllITAdmins() {
  return ITAdminModel.findAll()
}

export async function getITAdminById(userId: string) {
  const itAdmin = await ITAdminModel.findById(userId)
  if (!itAdmin) throw new Error('IT Admin not found')
  return itAdmin
}

export async function createITAdmin(dto: CreateITAdminInput, actorId?: string | null, ip?: string | null) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'it_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await ITAdminModel.create(userId, dto)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'it_admin_created',
      description: `IT Admin ${dto.email} created (user: ${userId})`,
  
    })

    return result
  } catch (err: any) {
    console.error('IT Admin creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`IT Admin Creation Failed: ${err.message}`)
  }
}

export async function updateITAdmin(userId: string, dto: UpdateITAdminInput, actorId?: string | null, ip?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: dto.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await ITAdminModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'it_admin_updated',
    description: `IT Admin ${userId} updated`,

  })

  return result
}

export async function deleteITAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await ITAdminModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'it_admin_deleted',
    description: `IT Admin ${userId} deleted`,

  })

  return result
}

export async function deactivateITAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'it_admin', 'it_admin_deactivated', 'IT Admin', actorId, ip)
}

export async function activateITAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'it_admin', 'it_admin_activated', 'IT Admin', actorId, ip)
}
