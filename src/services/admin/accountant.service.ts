import { supabase } from '../../lib/supabase.js'
import * as AccountantModel from '../../models/admin/accountant.model.js'
import { BaseCreateDTO } from '../../types/user.types.js'

interface UpdateAccountantDTO {
  first_name?: string
  last_name?: string
  middle_initial?: string | null
  suffix?: string | null
  username?: string
  email?: string
  phone?: string | null
}

export async function getAllAccountants() {
  return AccountantModel.findAll()
}

export async function getAccountantById(userId: string) {
  const accountant = await AccountantModel.findById(userId)
  if (!accountant) throw new Error('Accountant not found')
  return accountant
}

export async function createAccountant(dto: BaseCreateDTO) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password:      dto.password,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: {
      role: 'accountant',
      display_name: dto.username,
    }
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await AccountantModel.create(userId, dto)
  } catch (err: any) {
    console.error('Accountant creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Accountant Creation Failed: ${err.message}`)
  }
}

export async function updateAccountant(userId: string, dto: UpdateAccountantDTO) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: dto.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }
  return AccountantModel.update(userId, dto)
}

export async function deleteAccountant(userId: string) {
  return AccountantModel.remove(userId)
}
