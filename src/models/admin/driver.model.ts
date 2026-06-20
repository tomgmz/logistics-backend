import { supabase } from '../../lib/supabase.js'
import { createUserWithProfile } from '../../lib/user-provisioning.js'
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
  // Prevent duplicate license numbers at model level
  if (dto.license_number) {
    const { data: existing, error: checkErr } = await supabase
      .from('drivers')
      .select('driver_id')
      .eq('license_number', dto.license_number)
      .maybeSingle()
    if (checkErr) throw checkErr
    if (existing) throw new Error('duplicate key: license_number')
  }
  await createUserWithProfile(
    userId,
    'driver',
    {
      email:                dto.email,
      first_name:           dto.first_name,
      last_name:            dto.last_name,
      middle_name:          dto.middle_name ?? null,
      suffix:               dto.suffix ?? null,
      phone:                dto.phone ?? null,
      created_by:           dto.created_by ?? null,
      must_change_password: true,
    },
    {
      license_number:    dto.license_number,
      license_expiry:    dto.license_expiry,
      license_image_url: dto.license_image_url ?? null,
      is_vendor_driver:  dto.is_vendor_driver ?? false,
      vendor_id:         dto.vendor_id ?? null,
    },
  )

  return findById(userId)
}

async function update(userId: string, dto: UpdateDriverDTO) {
  const userFields: Record<string, any> = {}
  if (dto.first_name  !== undefined) userFields.first_name  = dto.first_name
  if (dto.last_name   !== undefined) userFields.last_name   = dto.last_name
  if (dto.middle_name !== undefined) userFields.middle_name = dto.middle_name
  if (dto.suffix      !== undefined) userFields.suffix      = dto.suffix
  if (dto.phone       !== undefined) userFields.phone       = dto.phone
  if (dto.email       !== undefined) userFields.email       = dto.email

  if (Object.keys(userFields).length > 0) {
    const { error } = await supabase.from('users').update(userFields).eq('user_id', userId)
    if (error) throw error
  }

  const driverFields: Record<string, any> = {}
  if (dto.license_number    !== undefined) driverFields.license_number    = dto.license_number
  if (dto.license_expiry    !== undefined) driverFields.license_expiry    = dto.license_expiry
  if (dto.license_image_url !== undefined) driverFields.license_image_url = dto.license_image_url
  if (dto.is_vendor_driver  !== undefined) driverFields.is_vendor_driver  = dto.is_vendor_driver
  if (dto.vendor_id         !== undefined) driverFields.vendor_id         = dto.vendor_id

  if (dto.is_vendor_driver === false) {
    driverFields.vendor_id = null
  }

  if (Object.keys(driverFields).length > 0) {
    // If license_number is being changed, ensure no other driver uses it
    if (driverFields.license_number) {
      const { data: existing, error: checkErr } = await supabase
        .from('drivers')
        .select('driver_id, user_id')
        .eq('license_number', driverFields.license_number)
        .maybeSingle()
      if (checkErr) throw checkErr
      if (existing && existing.user_id !== userId) throw new Error('duplicate key: license_number')
    }
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