import { supabase } from '../../lib/supabase.js'
import * as VendorModel from '../../models/admin/vendor.model.js'
import { CreateVendorInput, UpdateVendorInput } from '../../types/vendor.types.js'

export async function getAllVendors() {
  return VendorModel.findAll()
}

export async function getVendorById(userId: string) {
  const vendor = await VendorModel.findById(userId)
  if (!vendor) throw new Error('Vendor not found')
  return vendor
}

export async function createVendor(input: CreateVendorInput) {
  const e164Phone = input.phone ? '+63' + input.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: {
      role: 'vendor',
      display_name: input.username,
    }
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    return await VendorModel.create(userId, input)
  } catch (err: any) {
    console.error('Vendor creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Vendor creation failed: ${err.message}`)
  }
}

export async function updateVendor(userId: string, input: UpdateVendorInput) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: input.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }
  return VendorModel.update(userId, input)
}

export async function deleteVendor(userId: string) {
  return VendorModel.remove(userId)
}