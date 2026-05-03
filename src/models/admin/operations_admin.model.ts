import { supabase } from '../../lib/supabase.js'
import { BaseCreateDTO } from '../../types/user.types.js'

interface UpdateOperationsAdminDTO {
  first_name?: string
  last_name?: string
  middle_name?: string | null
  suffix?: string | null
  username?: string
  email?: string
  phone?: string | null
}

async function findAll() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('role', 'operations_admin')
    .neq('status', 'archived')
    .order('last_name', { ascending: true })

  if (error) throw error
  return data
}

async function findById(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .eq('role', 'operations_admin')
    .neq('status', 'archived')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(userId: string, dto: BaseCreateDTO) {
  const { error: userError } = await supabase
    .from('users')
    .insert({
      user_id:        userId,
      username:       dto.username,
      email:          dto.email,
      first_name:     dto.first_name,
      last_name:      dto.last_name,
      middle_name: dto.middle_name ?? null,
      suffix:         dto.suffix ?? null,
      phone:          dto.phone,
      role:           'operations_admin',
      created_by:     dto.created_by ?? null,
    })
  if (userError) throw userError

  return findById(userId)
}

async function update(userId: string, dto: UpdateOperationsAdminDTO) {
  const userFields: Record<string, any> = {}
  if (dto.first_name     !== undefined) userFields.first_name     = dto.first_name
  if (dto.last_name      !== undefined) userFields.last_name      = dto.last_name
  if (dto.middle_name !== undefined) userFields.middle_name = dto.middle_name
  if (dto.suffix         !== undefined) userFields.suffix         = dto.suffix
  if (dto.phone          !== undefined) userFields.phone          = dto.phone
  if (dto.email          !== undefined) userFields.email          = dto.email
  if (dto.username       !== undefined) userFields.username       = dto.username

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
    if (error) throw error
  }

  return findById(userId)
}

async function remove(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .update({ status: 'archived' })
    .eq('user_id', userId)
    .select('user_id, status')

  if (error) throw error
  if (!data || data.length === 0) throw new Error(`No user found with ID: ${userId}`)
  return true
}

export { findAll, findById, create, update, remove }