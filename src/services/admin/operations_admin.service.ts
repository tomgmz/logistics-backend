import { supabase } from '../../lib/supabase.js'
import * as OperationsAdminModel from '../../models/admin/operations_admin.model.js'
import { BaseCreateDTO } from '../../types/user.types.js'

interface UpdateOperationsAdminDTO {
  first_name?: string
  last_name?: string
  middle_initial?: string | null
  suffix?: string | null
  username?: string
  email?: string
  phone?: string | null
}

export async function getAllOperationsAdmins() {
  return OperationsAdminModel.findAll()
}

export async function getOperationsAdminById(userId: string) {
  const opsAdmin = await OperationsAdminModel.findById(userId)
  if (!opsAdmin) throw new Error('Operations Admin not found')
  return opsAdmin
}

export async function createOperationsAdmin(dto: BaseCreateDTO) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: {
      role: 'operations_admin',
      display_name: dto.username,
    },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await OperationsAdminModel.create(userId, dto)
  } catch (err: any) {
    console.error('Operations Admin creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Operations Admin Creation Failed: ${err.message}`)
  }
}

export async function updateOperationsAdmin(userId: string, dto: UpdateOperationsAdminDTO) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: dto.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }
  return OperationsAdminModel.update(userId, dto)
}

export async function deleteOperationsAdmin(userId: string) {
  return OperationsAdminModel.remove(userId)
}