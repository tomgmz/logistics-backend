import { supabase } from '../../lib/supabase.js'
import * as GeneralManagerModel from '../../models/admin/general_manager.model.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'

interface UpdateGeneralManagerDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
  username?: string
  email?: string
  phone?: string | null
}

export async function getAllGeneralManagers() {
  return GeneralManagerModel.findAll()
}

export async function getGeneralManagerById(userId: string) {
  const gm = await GeneralManagerModel.findById(userId)
  if (!gm) throw new Error('General Manager not found')
  return gm
}

export async function createGeneralManager(dto: BaseCreateDTO, actorId?: string | null, ip?: string | null) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'general_manager', display_name: dto.username },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await GeneralManagerModel.create(userId, dto)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'general_manager_created',
      description: `General Manager ${dto.email} created (user: ${userId})`,
      ip_address:  ip,
    })

    return result
  } catch (err: any) {
    console.error('General Manager creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`General Manager Creation Failed: ${err.message}`)
  }
}

export async function updateGeneralManager(userId: string, dto: UpdateGeneralManagerDTO, actorId?: string | null, ip?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: dto.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await GeneralManagerModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'general_manager_updated',
    description: `General Manager ${userId} updated`,
    ip_address:  ip,
  })

  return result
}

export async function deleteGeneralManager(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await GeneralManagerModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'general_manager_deleted',
    description: `General Manager ${userId} deleted`,
    ip_address:  ip,
  })

  return result
}