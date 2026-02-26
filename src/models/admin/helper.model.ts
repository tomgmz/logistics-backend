import { supabase } from '../../lib/supabase.js'
import { CreateHelperDTO, UpdateHelperDTO } from '../../types/helper.types.js'

async function findAll() {
  const { data, error } = await supabase
    .from('users')
    .select(`*, helpers(*)`)
    .eq('role', 'helper')
    .neq('status', 'active')
    .order('last_name', { ascending: true })

  if (error) throw error
  return data
}

async function findById(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select(`*, helpers(*)`)
    .eq('user_id', userId)
    .eq('role', 'helper')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(userId: string, dto: CreateHelperDTO) {
  const { error: userError } = await supabase
    .from('users')
    .insert({
      user_id:        userId,
      username:       dto.username,
      email:          dto.email,
      first_name:     dto.first_name,
      last_name:      dto.last_name,
      middle_initial: dto.middle_initial ?? null,
      suffix:         dto.suffix ?? null,
      phone:          dto.phone ? '+63' + dto.phone.slice(1) : null,
      role:           'helper',
      created_by:     dto.created_by ?? null,
    })
  if (userError) throw userError

  const { error: helperError } = await supabase
    .from('helpers')
    .insert({
      user_id:        userId,
      license_number: dto.license_number ?? null,
      license_expiry: dto.license_expiry ?? null,
    })
  if (helperError) throw helperError

  await supabase.from('system_logs').insert({
    user_id:     dto.created_by ?? null,
    log_type:    'user_activity',
    action:      'helper_creation',
    description: `Helper ${dto.username} created.`,
  })

  return findById(userId)
}

async function update(userId: string, dto: UpdateHelperDTO) {
  const userFields: Record<string, any> = {}
  if (dto.first_name     !== undefined) userFields.first_name     = dto.first_name
  if (dto.last_name      !== undefined) userFields.last_name      = dto.last_name
  if (dto.middle_initial !== undefined) userFields.middle_initial = dto.middle_initial
  if (dto.suffix         !== undefined) userFields.suffix         = dto.suffix
  if (dto.phone          !== undefined) userFields.phone          = dto.phone ? '+63' + dto.phone.slice(1) : null
  if (dto.email          !== undefined) userFields.email          = dto.email
  if (dto.username       !== undefined) userFields.username       = dto.username

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
    if (error) throw error
  }

  const helperFields: Record<string, any> = {}
  if (dto.license_number !== undefined) helperFields.license_number = dto.license_number
  if (dto.license_expiry !== undefined) helperFields.license_expiry = dto.license_expiry
  if (dto.driver_status  !== undefined) helperFields.status         = dto.driver_status

  if (Object.keys(helperFields).length > 0) {
    const { error } = await supabase.from('helpers').update(helperFields).eq('user_id', userId)
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