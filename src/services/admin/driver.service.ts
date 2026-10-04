import { supabase } from '../../lib/supabase.js'
import { activateUserWithUnban, banArchivedAuthUser, deactivateUserWithBan } from './user-auth-status.service.js'
import * as DriverModel from '../../models/admin/driver.model.js'
import * as WebauthnModel from '../../models/auth/webauthn.model.js'
import { CreateDriverDTO, UpdateDriverDTO } from '../../types/driver.types.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { driversAvailableOn } from '../driver/availability.service.js'
import { unreturnedVehiclesFor } from '../../lib/driver-reservation.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'
import { createExternalDriver } from '../auth/driver-enrollment.service.js'
import { requestLicenseExpiryCheck } from '../notification/license-expiry.scheduler.js'

export async function getAllDrivers() {
  return DriverModel.findAll()
}

/**
 * The drivers operations can put on a booking scheduled for `day`.
 *
 * Three filters, matching `assertDriverAssignable` exactly so the dropdown never
 * offers a driver the assignment call would then refuse: they ticked that day on
 * their calendar, nothing has stopped them working, and they are not still
 * holding a vehicle from a booking they finished but never brought back.
 * `currentDriverIds` are the drivers already on the booking being edited (main
 * and second) — they are 'assigned' and so would filter themselves out of their
 * own assignment.
 */
export async function getAssignableDrivers(day: string, currentDriverIds: string[] = []) {
  const [drivers, ticked] = await Promise.all([
    DriverModel.findAll(),
    driversAvailableOn(day),
  ])

  const driverIds = (drivers ?? [])
    .map((user: any) => (Array.isArray(user.drivers) ? user.drivers[0] : user.drivers)?.driver_id)
    .filter(Boolean) as string[]

  // One query for the roster rather than one per driver — this runs on every
  // booking the operator opens.
  const unreturned = await unreturnedVehiclesFor(driverIds)

  return (drivers ?? []).filter((user: any) => {
    const profile = Array.isArray(user.drivers) ? user.drivers[0] : user.drivers
    if (!profile?.driver_id) return false
    if (currentDriverIds.includes(profile.driver_id)) return true

    return ticked.has(profile.driver_id)
      && !BLOCKING_DRIVER_STATUSES.includes(profile.status)
      && !unreturned.has(profile.driver_id)
  })
}

/** Mirrors the blocking states in `assertDriverAssignable`. */
const BLOCKING_DRIVER_STATUSES = ['assigned', 'on_leave', 'inactive']

export async function getDriverById(userId: string) {
  const driver = await DriverModel.findById(userId)
  if (!driver) throw new Error('Driver not found')
  return driver
}

export async function createDriver(dto: CreateDriverDTO, actorId?: string | null) {
  // A vendor driver gets a passkey-only account and a setup link instead of a
  // password and a welcome email. Same details otherwise, so they show up in the
  // license reminder and the Driver Management flag like any company driver.
  if (dto.is_external) {
    if (!dto.vendor_name?.trim()) throw new Error('Vendor name is required for a vendor driver')
    const { userId } = await createExternalDriver({
      email:             dto.email,
      first_name:        dto.first_name,
      last_name:         dto.last_name,
      middle_name:       dto.middle_name ?? null,
      suffix:            dto.suffix ?? null,
      phone:             dto.phone ?? null,
      license_number:    dto.license_number,
      license_expiry:    dto.license_expiry,
      license_image_url: dto.license_image_url ?? null,
      vendor_name:       dto.vendor_name,
      vendor_contact:    dto.vendor_contact ?? null,
      actorId:           actorId ?? dto.created_by ?? null,
    })
    requestLicenseExpiryCheck()
    return DriverModel.findById(userId)
  }

  const password  = generateSecurePassword()
  const e164Phone = dto.phone ? '+63' + dto.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         dto.email,
    password,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'driver' },
  })
  if (authError) throw new Error(`Auth error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await DriverModel.create(userId, { ...dto, created_by: actorId ?? dto.created_by ?? null })

    sendWelcomeEmail({
      to:        dto.email,
      firstName: dto.first_name ?? null,
      role:      'driver',
      password,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`WELCOME_EMAIL_FAILED for driver ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_management',
      action:      'driver_created',
      description: `Driver ${dto.email} created (user: ${userId})`,
    })

    // A license already inside the reminder window is reminded now, not on the
    // next hourly tick.
    requestLicenseExpiryCheck()

    return result
  } catch (err: any) {
    console.error('Driver creation failed, rolling back auth user...', err.message)
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    throw new Error(`Driver creation failed: ${err.message}`)
  }
}

export async function updateDriver(userId: string, dto: UpdateDriverDTO, actorId?: string | null) {
  if (dto.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: dto.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await DriverModel.update(userId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'driver_updated',
    description: `Driver ${userId} updated`,
  })

  // A new expiry date re-arms the reminder; check it now rather than within the hour.
  if (dto.license_expiry !== undefined) requestLicenseExpiryCheck()

  return result
}

export async function deleteDriver(userId: string, actorId?: string | null) {
  const result = await DriverModel.remove(userId)
  await banArchivedAuthUser(userId)
  // Only vendor drivers hold passkeys; for everyone else this is a no-op. The ban
  // already blocks sign-in, but a passkey left live would come back the moment
  // the account is reused, and would block a fresh setup on the same phone with
  // "one of the excluded credentials exists on the local device".
  await WebauthnModel.revokeAllForUser(userId, actorId ?? null, 'Account deleted')

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'driver_deleted',
    description: `Driver ${userId} deleted`,
  })

  return result
}

/**
 * Clear a driver's 'assigned' reservation from the operations side.
 *
 * The recovery hatch for a driver pinned to a delivery that is no longer there.
 * They cannot fix it themselves — the app's switch is locked while 'assigned' —
 * and until now nobody could, so the account simply fell out of the assignable
 * pool for good.
 *
 * This releases a reservation, not a delivery: a driver genuinely out on the
 * road is refused, with the booking named, so the only way to take someone off
 * live work is still to finish or cancel that booking. They land on 'available'
 * because they never drove.
 */
export async function standDownDriver(userId: string, actorId?: string | null) {
  const driver = await DriverModel.findById(userId)
  if (!driver) throw new Error('Driver not found')

  const profile = (driver as any).drivers
  const record  = Array.isArray(profile) ? profile[0] : profile
  if (!record?.driver_id) throw new Error('Driver not found')

  if (record.status !== 'assigned') {
    throw new Error(`This driver is not reserved (status: ${record.status}) — there is nothing to stand down`)
  }

  const live = await liveDeliveryFor(record.driver_id)
  if (live) {
    throw new Error(
      `This driver is on an active delivery for booking ${live.reference} — finish or cancel that booking to release them`,
    )
  }

  const { error } = await supabase
    .from('drivers')
    .update({ status: 'available', updated_at: new Date().toISOString() })
    .eq('driver_id', record.driver_id)
    .eq('status', 'assigned')
  if (error) throw error

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'driver_stood_down',
    description: `Driver ${record.driver_id} released from a stale 'assigned' reservation and returned to the available pool`,
  })

  return DriverModel.findById(userId)
}

/** The unfinished booking a driver is actually out on, if any. */
async function liveDeliveryFor(driverId: string): Promise<{ reference: string } | null> {
  // As the main driver (deliveries) or as a booking's second driver.
  const [main, second] = await Promise.all([
    supabase.from('deliveries').select('booking_id, bookings ( status, reference_number )').eq('driver_id', driverId),
    supabase.from('driver_assignments').select('booking_id, bookings ( status, reference_number )')
      .eq('driver_id', driverId).eq('crew_role', 'second'),
  ])

  if (main.error)   throw main.error
  if (second.error) throw second.error

  for (const row of [...(main.data ?? []), ...(second.data ?? [])] as any[]) {
    const booking = row.bookings
    if (!booking?.status) continue
    if (booking.status === 'delivered' || booking.status === 'completed' || booking.status === 'cancelled') continue
    return { reference: bookingRef({ ...booking, booking_id: row.booking_id }) }
  }
  return null
}

export async function deactivateDriver(userId: string, actorId?: string | null) {
  return deactivateUserWithBan(userId, 'driver', 'driver_deactivated', 'Driver', actorId)
}

export async function activateDriver(userId: string, actorId?: string | null) {
  return activateUserWithUnban(userId, 'driver', 'driver_activated', 'Driver', actorId)
}