import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import * as VendorModel from '../../models/admin/vendor.model.js'
import { CreateVendorInput, UpdateVendorInput } from '../../types/vendor.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'

export async function getAllVendors() {
  return VendorModel.findAll()
}

export async function getVendorById(userId: string) {
  const vendor = await VendorModel.findById(userId)
  if (!vendor) throw new Error('Vendor not found')
  return vendor
}

export async function createVendor(input: CreateVendorInput, actorId?: string | null, ip?: string | null) {
  const password = generateSecurePassword()
  const e164Phone = input.phone ? '+63' + input.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'vendor' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await VendorModel.create(userId, input)

    sendWelcomeEmail({
      to:        input.email,
      firstName: input.first_name ?? null,
      role:      'vendor',
      password,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
      console.error(`WELCOME_EMAIL_FAILED for vendor ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'vendor_created',
      description: `Vendor ${input.email} created (user: ${userId})`,
  
    })

    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
    console.error('Vendor creation failed, rolling back auth user...', msg)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Vendor creation failed: ${msg}`)
  }
}

export async function updateVendor(userId: string, input: UpdateVendorInput, actorId?: string | null, ip?: string | null) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: input.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await VendorModel.update(userId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'vendor_updated',
    description: `Vendor ${userId} updated`,

  })

  return result
}

export async function deleteVendor(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await VendorModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'vendor_deleted',
    description: `Vendor ${userId} deleted`,

  })

  return result
}

export async function deactivateVendor(userId: string, actorId?: string | null, ip?: string | null) {
  return deactivateUserWithBan(userId, 'vendor', 'vendor_deactivated', 'Vendor', actorId, ip)
}

export async function activateVendor(userId: string, actorId?: string | null, ip?: string | null) {
  return activateUserWithUnban(userId, 'vendor', 'vendor_activated', 'Vendor', actorId, ip)
}
