import { supabase } from '../../lib/supabase.js'
import * as AccountantModel from '../../models/admin/accountant.model.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'

interface UpdateAccountantDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
  email?: string
  phone?: string | null
}

export async function getAllAccountants() {
  return AccountantModel.findAll()
}

export async function getAccountantById(userId: string) {
  const accountant = await AccountantModel.findById(userId)
  if (!accountant) throw new Error('Accountant not found')
  return accountant
}

export async function createAccountant(dto: BaseCreateDTO, actorId?: string | null, ip?: string | null) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: {
      role:         'accountant',
    },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await AccountantModel.create(userId, dto)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'accountant_created',
      description: `Accountant ${dto.email} created (user: ${userId})`,
      ip_address:  ip,
    })

    return result
  } catch (err: any) {
    console.error('Accountant creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Accountant Creation Failed: ${err.message}`)
  }
}

export async function updateAccountant(userId: string, dto: UpdateAccountantDTO, actorId?: string | null, ip?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: dto.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await AccountantModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'accountant_updated',
    description: `Accountant ${userId} updated`,
    ip_address:  ip,
  })

  return result
}

export async function deleteAccountant(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await AccountantModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'accountant_deleted',
    description: `Accountant ${userId} archived`,
    ip_address:  ip,
  })

  return result
}

export async function deactivateAccountant(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'accountant', 'accountant_deactivated', 'Accountant', actorId, ip)
}

export async function activateAccountant(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'accountant', 'accountant_activated', 'Accountant', actorId, ip)
}