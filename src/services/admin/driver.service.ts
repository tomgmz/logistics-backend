import { supabase } from '../../lib/supabase.js'
import * as DriverModel from '../../models/admin/driver.model.js'
import { CreateDriverDTO, UpdateDriverDTO } from '../../types/driver.types.js'

export async function getAllDrivers() {
  return DriverModel.findAll()
}

export async function getDriverById(userId: string) {
  const driver = await DriverModel.findById(userId)
  if (!driver) throw new Error('Driver not found')
  return driver
}

export async function createDriver(dto: CreateDriverDTO) {
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password:      dto.password,
    email_confirm: true,
    phone:         dto.phone ?? undefined,
    user_metadata: { role: 'driver' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await DriverModel.create(userId, dto)
  } catch (err: any) {
    console.error('Driver creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Driver Creation Failed: ${err.message}`)
  }
}

export async function updateDriver(userId: string, dto: UpdateDriverDTO) {
  return DriverModel.update(userId, dto)
}

export async function deleteDriver(userId: string) {
  const { error } = await supabase.auth.admin.deleteUser(userId)
  if (error) throw new Error(`Auth deletion failed: ${error.message}`)
  return DriverModel.remove(userId)
}