import { supabase } from '../../lib/supabase.js'
import * as ITAdminModel from '../../models/admin/it_admin.model.js'
import { CreateITAdminInput, UpdateITAdminInput } from '../../types/it_admin.types.js'

export async function getAllITAdmins() {
  return ITAdminModel.findAll()
}

export async function getITAdminById(userId: string) {
  const itAdmin = await ITAdminModel.findById(userId)
  if (!itAdmin) throw new Error('IT Admin not found')
  return itAdmin
}

export async function createITAdmin(dto: CreateITAdminInput) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: {
      role:         'it_admin',
      display_name: dto.username,
    },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await ITAdminModel.create(userId, dto)
  } catch (err: any) {
    console.error('IT Admin creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`IT Admin Creation Failed: ${err.message}`)
  }
}

export async function updateITAdmin(userId: string, dto: UpdateITAdminInput) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: dto.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }
  return ITAdminModel.update(userId, dto)
}

export async function deleteITAdmin(userId: string) {
  return ITAdminModel.remove(userId)
}