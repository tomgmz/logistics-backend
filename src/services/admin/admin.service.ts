import { supabase } from '../../lib/supabase.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'
import * as AdminModel from '../../models/admin/admin.model.js'
import { CreateAdminInput, UpdateAdminInput } from '../../types/admin.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllAdmin() {
  return AdminModel.findAll()
}

export async function getAdminById(userId: string) {
  const admin = await AdminModel.findById(userId)
  if (!admin) throw new Error('Admin not found')
  return admin
}

export async function createAdmin(input: CreateAdminInput, actorId?: string | null, ip?: string | null) {
  const e164Phone = input.phone ? '+63' + input.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await AdminModel.create(userId, input)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'admin_created',
      description: `Admin ${input.email} created (user: ${userId})`,
  
    })

    return result
  } catch (err: any) {
    console.error('Admin creation failed, rolling back auth user...', err.message)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan with user ID:', userId)
    throw err
  }
}

export async function updateAdmin(userId: string, input: UpdateAdminInput, actorId?: string | null, ip?: string | null) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: input.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await AdminModel.update(userId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'admin_updated',
    description: `Admin ${userId} updated`,

  })

  return result
}

export async function deleteAdmin(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await AdminModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'admin_deleted',
    description: `Admin ${userId} deleted`,

  })

  return result
}
