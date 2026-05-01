import { supabase } from "../../lib/supabase.js";
import { CreateAdminInput, UpdateAdminInput } from "../../types/admin.types.js";

async function findAll() {
    const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('role', 'admin')
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
    .eq('role', 'admin')
    .neq('status', 'archived')
    .maybeSingle()
    
    if (error) throw error
    return data
}

async function create(userId: string, input: CreateAdminInput) {
    const { data, error: userError } = await supabase
    .from('users')
    .insert({
        user_id:     userId,
        username:    input.username,
        email:       input.email,
        first_name:  input.first_name,
        last_name:   input.last_name,
        middle_initial: input.middle_initial ?? null,
        suffix:      input.suffix,
        phone:       input.phone,
        role:        'admin',
        created_by:  input.created_by ?? null,
    })
    .select()
    .single()

    if (userError) throw userError

    return data
}

async function update(userId: string, input: UpdateAdminInput) {
    const userFields: Record<string, any> = {}
    if (input.first_name     != undefined) userFields.first_name =     input.first_name
    if (input.last_name      != undefined) userFields.last_name =      input.last_name
    if (input.middle_initial != undefined) userFields.middle_initial = input.middle_initial
    if (input.suffix         != undefined) userFields.suffix =         input.suffix
    if (input.phone !== undefined) userFields.phone =                  input.phone 
    if (input.email          != undefined) userFields.email =          input.email
    if (input.username       != undefined) userFields.username =       input.username

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

export {findAll, findById, create, update, remove}
