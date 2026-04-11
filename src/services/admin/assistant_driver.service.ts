import { supabase } from '../../lib/supabase.js'
import * as AssistantDriverModel from '../../models/admin/assistant_driver.model.js'
import { CreateAssistantDriverDTO, UpdateAssistantDriverDTO } from '../../types/assistant_driver.types.js'

export async function getAllAssistantDrivers() {
  return AssistantDriverModel.findAll()
}

export async function getAssistantDriverById(userId: string) {
  const assistantDriver = await AssistantDriverModel.findById(userId)
  if (!assistantDriver) throw new Error('Assistant Driver not found')
  return assistantDriver
}

export async function createAssistantDriver(dto: CreateAssistantDriverDTO) {
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password:      dto.password,
    email_confirm: true,
    phone:         e164Phone,
    user_metadata: {
      role: 'assistant_driver',
      display_name: dto.username,
    }
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await AssistantDriverModel.create(userId, dto)
  } catch (err: any) {
    console.error('Assistant Driver creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Assistant Driver creation failed: ${err.message}`)
  }
}

export async function updateAssistantDriver(userId: string, dto: UpdateAssistantDriverDTO) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: dto.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }
  return AssistantDriverModel.update(userId, dto)
}

export async function deleteAssistantDriver(userId: string) {
  return AssistantDriverModel.remove(userId)
}