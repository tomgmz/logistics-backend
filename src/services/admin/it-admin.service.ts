import { supabase } from '../../lib/supabase.js'
import * as ITAdminModel from '../../models/admin/it-admin.model.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import { CreateITAdminInput, UpdateITAdminInput } from '../../types/it-admin.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'

export async function getAllITAdmins(actorId?: string | null) {
  return ITAdminModel.findAll(actorId ?? undefined)
}

export async function getITAdminById(userId: string) {
  const itAdmin = await ITAdminModel.findById(userId)
  if (!itAdmin) throw new Error('IT Admin not found')
  return itAdmin
}

export async function createITAdmin(
  input:    CreateITAdminInput,
  actorId?: string | null,
  ip?:      string | null,
) {
  const password = generateSecurePassword()

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password,
    email_confirm: true,
    user_metadata: { role: 'it_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await ITAdminModel.create(userId, input)

    sendWelcomeEmail({
      to:        input.email,
      firstName: input.first_name ?? null,
      role:      'it_admin',
      password,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
      console.error(`WELCOME_EMAIL_FAILED for it_admin ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'it_admin_created',
      description: `IT Admin ${input.email} created (user: ${userId})`,
    })

    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
    console.error('IT Admin creation failed, rolling back auth user...', msg)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) {
      console.error('ROLLBACK FAILED. Orphan auth user with ID:', userId)
    } else {
      console.log('Rollback successful.')
    }
    throw new Error(`IT Admin creation failed: ${msg}`)
  }
}

export async function updateITAdmin(
  userId:   string,
  input:    UpdateITAdminInput,
  actorId?: string | null,
  ip?:      string | null,
) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: input.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await ITAdminModel.update(userId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'it_admin_updated',
    description: `IT Admin ${userId} updated`,
  })

  return result
}

export async function deleteITAdmin(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  const result = await ITAdminModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'it_admin_deleted',
    description: `IT Admin ${userId} deleted`,
  })

  return result
}

export async function deactivateITAdmin(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  return deactivateUserWithBan(userId, 'it_admin', 'it_admin_deactivated', 'IT Admin', actorId, ip)
}

export async function activateITAdmin(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  return activateUserWithUnban(userId, 'it_admin', 'it_admin_activated', 'IT Admin', actorId, ip)
}