import { supabase } from '../../lib/supabase.js'
import { createUserWithProfile } from '../../lib/user-provisioning.js'
import { CreateITAdminInput, ITAdminHandover, UpdateITAdminInput } from '../../types/it-admin.types.js'

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
    .select('user_id, email, first_name, last_name, status, render_ends_at')
    .eq('role', 'it_admin')
    .eq('status', 'active')

  if (error) throw error
  return data ?? []
}

/**
 * The seat holder: the active IT Admin who is NOT serving a render period.
 * `users_one_active_it_admin` allows at most one. A predecessor still rendering
 * is active too, but has already handed the role over.
 */
async function findSeatHolders() {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, last_name, status, render_ends_at')
    .eq('role', 'it_admin')
    .eq('status', 'active')
    .is('render_ends_at', null)

  if (error) throw error
  return data ?? []
}

/** The handover in progress (at most one), or null. */
async function findOpenHandover() {
  const { data, error } = await supabase
    .from('it_admin_handovers')
    .select('*')
    .is('ended_at', null)
    .is('cancelled_at', null)
    .maybeSingle()

  if (error) throw error
  return data as ITAdminHandover | null
}

/** Open handovers whose successor already set their own password (a missed completion). */
async function findConfirmedButOpen() {
  const { data, error } = await supabase
    .from('it_admin_handovers')
    .select('handover_id, successor_id, users!it_admin_handovers_successor_id_fkey!inner ( must_change_password, status )')
    .is('ended_at', null)
    .is('cancelled_at', null)
    .not('successor_id', 'is', null)
    .eq('users.must_change_password', false)
    .eq('users.status', 'active')

  if (error) throw error
  return (data ?? []) as unknown as { handover_id: string; successor_id: string }[]
}

async function updateHandover(handoverId: string, fields: Partial<ITAdminHandover>) {
  const { error } = await supabase.from('it_admin_handovers').update(fields).eq('handover_id', handoverId)
  if (error) throw error
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
  if (input.middle_name !== undefined) userFields.middle_name = input.middle_name
  if (input.suffix      !== undefined) userFields.suffix      = input.suffix
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

export { findAll, findById, findActive, findSeatHolders, findOpenHandover, findConfirmedButOpen, updateHandover, create, update, remove }