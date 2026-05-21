import { supabase } from '../../lib/supabase.js'
import { CreateITAdminInput, UpdateITAdminInput } from '../../types/it-admin.types.js'

async function findAll(excludeId?: string) {
  let query = supabase
    .from('users')
    .select('*')
    .eq('role', 'it_admin')
    .neq('status', 'archived')
    .order('last_name', { ascending: true })

  if (excludeId) query = query.neq('user_id', excludeId)

  const { data, error } = await query
  if (error) throw error
  return data
}

async function findById(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .eq('role', 'it_admin')
    .neq('status', 'archived')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(userId: string, input: CreateITAdminInput) {
  const { error } = await supabase
    .from('users')
    .insert({
      user_id:              userId,
      email:                input.email,
      first_name:           input.first_name,
      last_name:            input.last_name,
      middle_name:          input.middle_name ?? null,
      suffix:               input.suffix ?? null,
      phone:                input.phone ?? null,
      role:                 'it_admin',
      created_by:           input.created_by ?? null,
      must_change_password: true,
    })
  if (error) throw error
  return findById(userId)
}

async function update(userId: string, input: UpdateITAdminInput) {
  const userFields: Record<string, any> = {}
  if (input.first_name  != undefined) userFields.first_name  = input.first_name
  if (input.last_name   != undefined) userFields.last_name   = input.last_name
  if (input.middle_name != undefined) userFields.middle_name = input.middle_name
  if (input.suffix      != undefined) userFields.suffix      = input.suffix
  if (input.phone       != undefined) userFields.phone       = input.phone
  if (input.email       != undefined) userFields.email       = input.email

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