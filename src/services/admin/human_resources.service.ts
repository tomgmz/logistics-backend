import { supabase } from '../../lib/supabase.js'
import * as HumanResourcesModel from '../../models/admin/human_resources.model.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'

interface UpdateHumanResourcesDTO {
  first_name?: string
  last_name?: string
  middle_initial?: string | null
  suffix?: string | null
  username?: string
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
    user_metadata: { role: 'human_resources', display_name: dto.username },
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
      ip_address:  ip,
    })

    return result
  } catch (err: any) {
    console.error('Human Resources creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
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
    ip_address:  ip,
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
    ip_address:  ip,
  })

  return result
}