import { supabase } from '../../lib/supabase.js'
import * as SubcontractorModel from '../../models/admin/subcontractor.model.js'
import { CreateSubcontractorInput, UpdateSubcontractorInput } from '../../types/subcontractor.types.js'

export async function getAllSubcontractor() {
  return SubcontractorModel.findAll()
}

export async function getSubcontractorById(userId: string) {
  const subcontractor = await SubcontractorModel.findById(userId)
  if (!subcontractor) throw new Error('Subcontractor not found')
  return subcontractor
}

export async function createSubcontractor(input: CreateSubcontractorInput) {
  const e164Phone = input.phone ? '+63' + input.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password:      input.password,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: {
      role: 'subcontractor',
      display_name: input.username,
    }
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await SubcontractorModel.create(userId, input)
  } catch (err: any) {
    console.error('Subcontractor creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Subcontractor creation failed: ${err.message}`)
  }
}

export async function updateSubcontractor(userId: string, input: UpdateSubcontractorInput) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: input.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }
  return SubcontractorModel.update(userId, input)
}

export async function deleteSubcontractor(userId: string) {
  return SubcontractorModel.remove(userId)
}