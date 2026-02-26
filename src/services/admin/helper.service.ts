import { supabase } from '../../lib/supabase.js'
import * as HelperModel from '../../models/admin/helper.model.js'
import { CreateHelperDTO, UpdateHelperDTO } from '../../types/helper.types.js'

export async function getAllHelpers() {
  return HelperModel.findAll()
}

export async function getHelperById(userId: string) {
  const helper = await HelperModel.findById(userId)
  if (!helper) throw new Error('Helper not found')
  return helper
}

export async function createHelper(dto: CreateHelperDTO) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password:      dto.password,
    email_confirm: true,
    phone:         e164Phone,
    user_metadata: {
      role: 'helper',
      display_name: dto.username,
    }
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await HelperModel.create(userId, dto)
  } catch (err: any) {
    console.error('Helper creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Helper creation failed: ${err.message}`)
  }
}

export async function updateHelper(userId: string, dto: UpdateHelperDTO) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: dto.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }
  return HelperModel.update(userId, dto)
}

export async function deleteHelper(userId: string) {
  return HelperModel.remove(userId)
}