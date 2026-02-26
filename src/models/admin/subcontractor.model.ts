import { supabase } from '../../lib/supabase.js'
import { CreateSubcontractorInput, UpdateSubcontractorInput } from '../../types/subcontractor.types.js'

async function findAll() {
  const { data, error } = await supabase
    .from('users')
    .select(`*, subcontractors(*)`)
    .eq('role', 'subcontractor')
    .neq('status', 'archived')
    .order('last_name', { ascending: true })

  if (error) throw error
  return data
}

async function findById(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select(`*, subcontractors(*)`)
    .eq('user_id', userId)
    .eq('role', 'subcontractor')
    .neq('status', 'archived')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(userId: string, input: CreateSubcontractorInput) {
  const { error: userError } = await supabase
    .from('users')
    .insert({
      user_id:        userId,
      username:       input.username,
      email:          input.email,
      first_name:     input.first_name,
      last_name:      input.last_name,
      middle_initial: input.middle_initial ?? null,
      suffix:         input.suffix ?? null,
      phone:          input.phone ? '+63' + input.phone.slice(1) : null,
      role:           'subcontractor',
      created_by:     input.created_by ?? null,
    })
  if (userError) throw userError

  const { error: subError } = await supabase
    .from('subcontractors')
    .insert({
      user_id:            userId,
      subcontractor_type: input.subcontractor_type,
      company_name:       input.company_name ?? null,
      business_permit:    input.business_permit ?? null,
    })
  if (subError) throw subError

  await supabase.from('system_logs').insert({
    user_id:     input.created_by ?? null,
    log_type:    'user_activity',
    action:      'subcontractor_creation',
    description: `Subcontractor ${input.username} created.`,
  })

  return findById(userId)
}

async function update(userId: string, input: UpdateSubcontractorInput) {
  const userFields: Record<string, any> = {}
  if (input.first_name     !== undefined) userFields.first_name     = input.first_name
  if (input.last_name      !== undefined) userFields.last_name      = input.last_name
  if (input.middle_initial !== undefined) userFields.middle_initial = input.middle_initial
  if (input.suffix         !== undefined) userFields.suffix         = input.suffix
  if (input.phone !== undefined) userFields.phone = input.phone ? '+63' + input.phone.slice(1) : null
  if (input.email          !== undefined) userFields.email          = input.email
  if (input.username       !== undefined) userFields.username       = input.username

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
    if (error) throw error
  }

  const subFields: Record<string, any> = {}
  if (input.subcontractor_type !== undefined) subFields.subcontractor_type = input.subcontractor_type
  if (input.company_name       !== undefined) subFields.company_name       = input.company_name
  if (input.business_permit    !== undefined) subFields.business_permit    = input.business_permit

  if (Object.keys(subFields).length > 0) {
    const { error } = await supabase.from('subcontractors').update(subFields).eq('user_id', userId)
    if (error) throw error
  }

  return findById(userId)
}

async function remove(userId: string) {
  const { error } = await supabase
    .from('users')
    .update({ status: 'archived' })
    .eq('user_id', userId)
  if (error) throw error
  return true
}

export { findAll, findById, create, update, remove }