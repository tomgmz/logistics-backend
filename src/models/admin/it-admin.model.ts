import { supabase } from '../../lib/supabase.js'
import { createUserWithProfile } from '../../lib/user-provisioning.js'
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

/**
 * Every ACTIVE IT Admin. Normally zero or one — `users_one_active_it_admin`
 * makes more than one impossible — but it returns a list rather than a single
 * row so a caller can tell "none" from "one" without a not-found error, and so a
 * pre-migration database with duplicates reads honestly instead of throwing.
 *
 * Deliberately not filtered through findAll(): that one hides archived rows and
 * excludes the caller, both of which would make it useless for counting.
 */
async function findActive() {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, last_name, status')
    .eq('role', 'it_admin')
    .eq('status', 'active')

  if (error) throw error
  return data ?? []
}

/** Active IT Admins other than this one — "would anyone be left?" */
async function countOtherActive(excludeUserId: string) {
  const { count, error } = await supabase
    .from('users')
    .select('user_id', { count: 'exact', head: true })
    .eq('role', 'it_admin')
    .eq('status', 'active')
    .neq('user_id', excludeUserId)

  if (error) throw error
  return count ?? 0
}

async function create(userId: string, input: CreateITAdminInput) {
  await createUserWithProfile(userId, 'it_admin', {
    email:                input.email,
    first_name:           input.first_name,
    last_name:            input.last_name,
    middle_name:          input.middle_name ?? null,
    suffix:               input.suffix ?? null,
    phone:                input.phone ?? null,
    created_by:           input.created_by ?? null,
    must_change_password: true,
  })
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

export { findAll, findById, findActive, countOtherActive, create, update, remove }