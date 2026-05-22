import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import * as HumanResourcesModel from '../../models/admin/human_resources.model.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'

interface UpdateHumanResourcesDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
  email?: string
  phone?: string | null
}

export async function getAllHumanResources() {
  return HumanResourcesModel.findAll()
}

export async function getHumanResourcesById(userId: string) {
  const hr = await HumanResourcesModel.findById(userId)
  if (!hr) throw new Error('Human Resources not found')
  return hr
}

export async function createHumanResources(dto: BaseCreateDTO, actorId?: string | null, ip?: string | null) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'human_resources' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await HumanResourcesModel.create(userId, dto)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'human_resources_created',
      description: `HR staff ${dto.email} created (user: ${userId})`,
  
    })

    return result
  } catch (err: any) {
    console.error('Human Resources creation failed, rolling back auth user...', err.message)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    throw new Error(`Human Resources Creation Failed: ${err.message}`)
  }
}

export async function updateHumanResources(userId: string, dto: UpdateHumanResourcesDTO, actorId?: string | null, ip?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: dto.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await HumanResourcesModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'human_resources_updated',
    description: `HR staff ${userId} updated`,

  })

  return result
}

export async function deleteHumanResources(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await HumanResourcesModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'human_resources_deleted',
    description: `HR staff ${userId} deleted`,

  })

  return result
}

export async function deactivateHumanResources(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'human_resources', 'human_resources_deactivated', 'Human Resources', actorId, ip)
}

export async function activateHumanResources(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'human_resources', 'human_resources_activated', 'Human Resources', actorId, ip)
}
