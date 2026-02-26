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
      username:       input.username,
      email:          input.email,
      first_name:     input.first_name,
      last_name:      input.last_name,
      middle_initial: input.middle_initial ?? null,
      suffix:         input.suffix ?? null,
      phone:          input.phone ? '+63' + input.phone.slice(1) : null,
      role:           'client',
      created_by:     input.created_by ?? null,
    })
    if (userError) throw userError

    const { error: clientError } = await supabase
    .from('clients')
    .insert({
        user_id:         userId,
        company_name:    input.company_name ?? null,
        billing_address: input.billing_address ?? null,
        payment_terms:   input.payment_terms ?? 30,
    })
    if (clientError) throw clientError

    await supabase.from('system_logs').insert({
        user_id:     input.created_by ?? null,
        log_type:    'user_activity',
        action:      'client_creation',
        description: `Client ${input.username} created.`,
    })

    return findById(userId)
}

async function update(userId: string, input: UpdateClientInput){
    const userFields: Record<string, any> = {}
    if (input.first_name     != undefined) userFields.first_name =     input.first_name
    if (input.last_name      != undefined) userFields.last_name =      input.last_name
    if (input.middle_initial != undefined) userFields.middle_initial = input.middle_initial
    if (input.suffix         != undefined) userFields.suffix =         input.suffix
    if (input.phone !== undefined) userFields.phone = input.phone ? '+63' + input.phone.slice(1) : null
    if (input.email          != undefined) userFields.email =          input.email
    if (input.username       != undefined) userFields.username =       input.username

    if (Object.keys(userFields).length > 0) {
        const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
        if (error) throw error
    }

    const clientFields: Record<string, any> = {}
    if (input.company_name    != undefined) clientFields.company_name = input.company_name
    if (input.billing_address != undefined) clientFields.billing_address = input.billing_address
    if (input.payment_terms   != undefined) clientFields.payment_terms = input.payment_terms

    if (Object.keys(clientFields).length > 0) {
        const { error } = await supabase.from('clients').update(clientFields).eq('user_id', userId)
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

export {findAll, findById, create, update, remove}

