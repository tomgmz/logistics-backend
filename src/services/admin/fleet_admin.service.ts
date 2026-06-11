import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import * as FleetAdminModel from '../../models/admin/fleet_admin.models.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'

interface UpdateFleetAdminDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
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
  const password = generateSecurePassword()
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'fleet_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await FleetAdminModel.create(userId, { ...dto, created_by: actorId ?? dto.created_by ?? null })

    sendWelcomeEmail({
      to:        dto.email,
      firstName: dto.first_name ?? null,
      role:      'fleet_admin',
      password,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
      console.error(`WELCOME_EMAIL_FAILED for fleet_admin ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'fleet_admin_created',
      description: `Fleet Admin ${dto.email} created (user: ${userId})`,
  
    })

    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
    console.error('Fleet Admin creation failed, rolling back auth user...', msg)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    throw new Error(`Fleet Admin creation failed: ${msg}`)
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

  })

  return result
}

export async function deactivateFleetAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'fleet_admin', 'fleet_admin_deactivated', 'Fleet Admin', actorId, ip)
}

export async function activateFleetAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'fleet_admin', 'fleet_admin_activated', 'Fleet Admin', actorId, ip)
}
