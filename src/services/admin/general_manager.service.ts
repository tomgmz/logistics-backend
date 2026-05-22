import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import * as GeneralManagerModel from '../../models/admin/general_manager.model.js'
import { BaseCreateDTO } from '../../types/user.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'

interface UpdateGeneralManagerDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
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
  const password = generateSecurePassword()
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'general_manager' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await GeneralManagerModel.create(userId, dto)

    sendWelcomeEmail({
      to:        dto.email,
      firstName: dto.first_name ?? null,
      role:      'general_manager',
      password,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
      console.error(`WELCOME_EMAIL_FAILED for general_manager ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'general_manager_created',
      description: `General Manager ${dto.email} created (user: ${userId})`,
  
    })

    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
    console.error('General Manager creation failed, rolling back auth user...', msg)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    throw new Error(`General Manager creation failed: ${msg}`)
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

  })

  return result
}

export async function deactivateGeneralManager(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'general_manager', 'general_manager_deactivated', 'General Manager', actorId, ip)
}

export async function activateGeneralManager(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'general_manager', 'general_manager_activated', 'General Manager', actorId, ip)
}
