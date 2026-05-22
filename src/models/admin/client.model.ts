import { supabase } from "../../lib/supabase.js";
import { CreateClientInput, UpdateClientInput } from "../../types/client.types.js";

async function findAll() {
  const { data, error } = await supabase
    .from('users')
    .select(`*, clients(*)`)
    .eq('role', 'client')
    .neq('status', 'archived')
    .order('last_name', { ascending: true })

  if (error) throw error
  return data
}

async function findById(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select(`*, clients(*)`)
    .eq('user_id', userId)
    .eq('role', 'client')
    .neq('status', 'archived')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(userId: string, input: CreateClientInput) {
    const { error: userError } = await supabase
    .from('users')
    .insert({
      user_id:        userId,
      email:          input.email,
      first_name:     input.first_name,
      last_name:      input.last_name,
      middle_name: input.middle_name ?? null,
      suffix:         input.suffix ?? null,
      phone:       input.phone,
      role:           'client',
      created_by:     input.created_by ?? null,
      must_change_password: true,
    })
    if (userError) throw userError

    const { error: clientError } = await supabase
    .from('clients')
    .insert({
        user_id:         userId,
        company_name:    input.company_name ?? null,
        billing_address: input.billing_address ?? null,
        payment_terms:   input.payment_terms ?? 30,
        landline:        input.landline        ?? null,  
    })
    if (clientError) throw clientError
    return findById(userId)
}

async function update(userId: string, input: UpdateClientInput) {
  const userFields: Record<string, any> = {}

  if ('first_name' in input) userFields.first_name = input.first_name
  if ('last_name' in input) userFields.last_name = input.last_name
  if ('middle_name' in input) userFields.middle_name = input.middle_name
  if ('suffix' in input) userFields.suffix = input.suffix
  if ('phone' in input) userFields.phone = input.phone
  if ('email' in input) userFields.email = input.email

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase
      .from('users')
      .update(userFields)
      .eq('user_id', userId)

    if (error) throw error
  }

  const clientFields: Record<string, any> = {}

  if ('company_name' in input) clientFields.company_name = input.company_name
  if ('billing_address' in input) clientFields.billing_address = input.billing_address
  if ('payment_terms' in input) clientFields.payment_terms = input.payment_terms
  if ('landline' in input) clientFields.landline = input.landline

  if (Object.keys(clientFields).length > 0) {
    const { error } = await supabase
      .from('clients')
      .update(clientFields)
      .eq('user_id', userId)

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

export {findAll, findById, create, update, remove}

