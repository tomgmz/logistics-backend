import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import * as DriverModel from '../../models/admin/driver.model.js'
import { CreateDriverDTO, UpdateDriverDTO } from '../../types/driver.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'

export async function getAllDrivers() {
  return DriverModel.findAll()
}

export async function getDriverById(userId: string) {
  const driver = await DriverModel.findById(userId)
  if (!driver) throw new Error('Driver not found')
  return driver
}

export async function createDriver(dto: CreateDriverDTO, actorId?: string | null, ip?: string | null) {
  const password  = generateSecurePassword()
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'driver' },
  })
  if (authError) throw new Error(`Auth error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await DriverModel.create(userId, { ...dto, created_by: actorId ?? dto.created_by ?? null })

    sendWelcomeEmail({
      to:        dto.email,
      firstName: dto.first_name ?? null,
      role:      'driver',
      password,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`WELCOME_EMAIL_FAILED for driver ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'driver_created',
      description: `Driver ${dto.email} created (user: ${userId})`,
    })

    return result
  } catch (err: any) {
    console.error('Driver creation failed, rolling back auth user...', err.message)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    throw new Error(`Driver creation failed: ${err.message}`)
  }
}

export async function updateDriver(userId: string, dto: UpdateDriverDTO, actorId?: string | null, ip?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: dto.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await DriverModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'driver_updated',
    description: `Driver ${userId} updated`,
  })

  return result
}

export async function deleteDriver(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await DriverModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'driver_deleted',
    description: `Driver ${userId} deleted`,
  })

  return result
}

export async function deactivateDriver(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'driver', 'driver_deactivated', 'Driver', actorId, ip)
}

export async function activateDriver(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'driver', 'driver_activated', 'Driver', actorId, ip)
}