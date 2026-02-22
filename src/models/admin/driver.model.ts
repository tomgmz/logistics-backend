import { supabase } from '../../lib/supabase.js'
import { CreateDriverDTO, UpdateDriverDTO } from '../../types/driver.types.js'

async function findAll() {
  const { data, error } = await supabase
    .from('users')
    .select(`*, drivers(*)`)
    .eq('role', 'driver')
    .order('last_name', { ascending: true })

  if (error) throw error
  return data
}

async function findById(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select(`*, drivers(*)`)
    .eq('user_id', userId)
    .eq('role', 'driver')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(userId: string, dto: CreateDriverDTO) {
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
      phone:          dto.phone ?? null,
      role:           'driver',
      created_by:     dto.created_by ?? null,
    })
  if (userError) throw userError

  const { data, error: driverError } = await supabase
    .from('drivers')
    .insert({
      user_id:                  userId,
      license_number:           dto.license_number,
      license_expiry:           dto.license_expiry,
      is_subcontractor_driver:  dto.is_subcontractor_driver ?? false,
      subcontractor_id:         dto.subcontractor_id ?? null,
    })
    .select()
    .single()
  if (driverError) throw driverError

  await supabase.from('system_logs').insert({
    user_id:     dto.created_by ?? null,
    log_type:    'user_activity',
    action:      'user_creation',
    description: `Driver ${dto.username} created.`,
  })

  return data
}

async function update(userId: string, dto: UpdateDriverDTO) {
  const userFields: Record<string, any> = {}
  if (dto.first_name     !== undefined) userFields.first_name     = dto.first_name
  if (dto.last_name      !== undefined) userFields.last_name      = dto.last_name
  if (dto.middle_initial !== undefined) userFields.middle_initial = dto.middle_initial
  if (dto.suffix         !== undefined) userFields.suffix         = dto.suffix
  if (dto.phone          !== undefined) userFields.phone          = dto.phone

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
    if (error) throw error
  }

  const driverFields: Record<string, any> = {}
  if (dto.license_number           !== undefined) driverFields.license_number           = dto.license_number
  if (dto.license_expiry           !== undefined) driverFields.license_expiry           = dto.license_expiry
  if (dto.is_subcontractor_driver  !== undefined) driverFields.is_subcontractor_driver  = dto.is_subcontractor_driver
  if (dto.subcontractor_id         !== undefined) driverFields.subcontractor_id         = dto.subcontractor_id

  if (Object.keys(driverFields).length > 0) {
    const { error } = await supabase.from('drivers').update(driverFields).eq('user_id', userId)
    if (error) throw error
  }

  return findById(userId)
}

async function remove(userId: string) {
  const { error } = await supabase.from('users').delete().eq('user_id', userId)
  if (error) throw error
  return true
}

export { findAll, findById, create, update, remove }