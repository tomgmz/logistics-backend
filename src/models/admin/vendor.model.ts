import { supabase } from '../../lib/supabase.js'
import { CreateVendorInput, UpdateVendorInput } from '../../types/vendor.types.js'

async function findAll() {
  const { data, error } = await supabase
    .from('users')
    .select(`*, vendors(*)`)
    .eq('role', 'vendor')
    .neq('status', 'archived')
    .order('last_name', { ascending: true })

  if (error) throw error
  return data
}

async function findById(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select(`*, vendors(*)`)
    .eq('user_id', userId)
    .eq('role', 'vendor')
    .neq('status', 'archived')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(userId: string, input: CreateVendorInput) {
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
      phone:          input.phone,
      role:           'vendor',
      created_by:     input.created_by ?? null,
    })
  if (userError) throw userError

  const { error: vendorError } = await supabase
    .from('vendors')
    .insert({
      user_id:        userId,
      vendor_type:    input.vendor_type,
      company_name:   input.company_name ?? null,
      business_permit: input.business_permit ?? null,
    })
  if (vendorError) throw vendorError

  await supabase.from('system_logs').insert({
    user_id:     input.created_by ?? null,
    log_type:    'user_activity',
    action:      'vendor_creation',
    description: `Vendor ${input.username} created.`,
  })

  return findById(userId)
}

async function update(userId: string, input: UpdateVendorInput) {
  const userFields: Record<string, any> = {}
  if (input.first_name     !== undefined) userFields.first_name     = input.first_name
  if (input.last_name      !== undefined) userFields.last_name      = input.last_name
  if (input.middle_initial !== undefined) userFields.middle_initial = input.middle_initial
  if (input.suffix         !== undefined) userFields.suffix         = input.suffix
  if (input.phone !== undefined) userFields.phone                   = input.phone
  if (input.email          !== undefined) userFields.email          = input.email
  if (input.username       !== undefined) userFields.username       = input.username

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
    if (error) throw error
  }

  const vendorFields: Record<string, any> = {}
  if (input.vendor_type !== undefined) vendorFields.vendor_type = input.vendor_type
  if (input.company_name       !== undefined) vendorFields.company_name       = input.company_name
  if (input.business_permit    !== undefined) vendorFields.business_permit    = input.business_permit

  if (Object.keys(vendorFields).length > 0) {
    const { error } = await supabase.from('vendors').update(vendorFields).eq('user_id', userId)
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