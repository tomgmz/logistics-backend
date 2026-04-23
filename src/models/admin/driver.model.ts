import { supabase } from '../../lib/supabase.js'
import { CreateDriverDTO, UpdateDriverDTO } from '../../types/driver.types.js'

async function findAll() {
  const { data, error } = await supabase
    .from('users')
    .select(`*, drivers(*)`)
    .eq('role', 'driver')
    .neq('status', 'archived')
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
    .neq('status', 'archived')
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
      phone:          dto.phone,
      role:           'driver',
      created_by:     dto.created_by ?? null,
    })
  if (userError) throw userError

  const { error: driverError } = await supabase
    .from('drivers')
    .insert({
      user_id:           userId,
      license_number:    dto.license_number,
      license_expiry:    dto.license_expiry,
      is_vendor_driver:  dto.is_vendor_driver ?? false,
      vendor_id:         dto.vendor_id ?? null,
    })
  if (driverError) throw driverError

  await supabase.from('system_logs').insert({
    user_id:     dto.created_by ?? null,
    log_type:    'user_activity',
    action:      'driver_creation',
    description: `Driver ${dto.username} created.`,
  })

  return findById(userId)
}

async function update(userId: string, dto: UpdateDriverDTO) {
  const userFields: Record<string, any> = {}
  if (dto.first_name     !== undefined) userFields.first_name     = dto.first_name
  if (dto.last_name      !== undefined) userFields.last_name      = dto.last_name
  if (dto.middle_initial !== undefined) userFields.middle_initial = dto.middle_initial
  if (dto.suffix         !== undefined) userFields.suffix         = dto.suffix
  if (dto.phone !== undefined) userFields.phone = dto.phone 
  if (dto.email          !== undefined) userFields.email          = dto.email
  if (dto.username       !== undefined) userFields.username       = dto.username

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
    if (error) throw error
  }

  const driverFields: Record<string, any> = {}
  if (dto.license_number      !== undefined) driverFields.license_number      = dto.license_number
  if (dto.license_expiry      !== undefined) driverFields.license_expiry      = dto.license_expiry
  if (dto.is_vendor_driver    !== undefined) driverFields.is_vendor_driver    = dto.is_vendor_driver
  if (dto.vendor_id           !== undefined) driverFields.vendor_id           = dto.vendor_id

  if (dto.is_vendor_driver === false) {
    driverFields.vendor_id = null
  }

  if (Object.keys(driverFields).length > 0) {
    const { error } = await supabase.from('drivers').update(driverFields).eq('user_id', userId)
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