import { supabase } from '../../lib/supabase.js'
import * as FleetAdminModel from '../../models/admin/fleet_admin.models.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'

interface UpdateFleetAdminDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
  username?: string
  email?: string
  phone?: string | null
}

export async function getAllFleetAdmins() {
  return FleetAdminModel.findAll()
}

export async function getFleetAdminById(userId: string) {
  const fleetAdmin = await FleetAdminModel.findById(userId)
  if (!fleetAdmin) throw new Error('Fleet Admin not found')
  return fleetAdmin
}

export async function createFleetAdmin(dto: BaseCreateDTO, actorId?: string | null, ip?: string | null) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'fleet_admin', display_name: dto.username },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await FleetAdminModel.create(userId, dto)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'fleet_admin_created',
      description: `Fleet Admin ${dto.email} created (user: ${userId})`,
      ip_address:  ip,
    })

    return result
  } catch (err: any) {
    console.error('Fleet Admin creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Fleet Admin Creation Failed: ${err.message}`)
  }
}

export async function updateFleetAdmin(userId: string, dto: UpdateFleetAdminDTO, actorId?: string | null, ip?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: dto.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await FleetAdminModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'fleet_admin_updated',
    description: `Fleet Admin ${userId} updated`,
    ip_address:  ip,
  })

  return result
}

export async function deleteFleetAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await FleetAdminModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'fleet_admin_deleted',
    description: `Fleet Admin ${userId} deleted`,
    ip_address:  ip,
  })

  return result
}