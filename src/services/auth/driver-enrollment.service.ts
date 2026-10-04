import crypto from 'node:crypto'
import { supabase } from '../../lib/supabase.js'
import { createUserWithProfile } from '../../lib/user-provisioning.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'
import { unbanAuthUser } from '../admin/user-auth-status.service.js'
import { logEvent } from '../../lib/log-event.js'
import { buildDriverSetupUrl, sendDriverEnrollmentEmail } from '../../lib/brevo-mailer.js'
import { INVITE_TTL_MS } from '../../lib/webauthn-config.js'
import { hashToken } from './auth.service.js'
import { generateInviteToken } from './webauthn.service.js'
import * as InviteModel from '../../models/auth/driver-invite.model.js'
import * as WebauthnModel from '../../models/auth/webauthn.model.js'
import * as AuthModel from '../../models/auth/auth.model.js'
import * as DriverModel from '../../models/admin/driver.model.js'

/**
 * Accounts for outside-vendor drivers.
 *
 * Vendor drivers are registered in Driver Management next to the company (8338)
 * drivers, with the same details plus the vendor they come from. Booking
 * Management then picks one from that roster for a vendor-supplied delivery and
 * copies their details onto the delivery snapshot, which remains the record of
 * who drove. Only the vehicle is typed per booking.
 *
 * The account is deliberately thin. It is role='driver' (access is scoped by
 * driver_assignments, not by role string), it is flagged is_external so it can
 * never be offered as company crew, and it has no usable password — the only way
 * in is a passkey the driver enrols on their own phone.
 */

export interface CreateExternalDriverInput {
  email:              string
  first_name:         string
  last_name:          string
  middle_name?:       string | null
  suffix?:            string | null
  phone?:             string | null
  license_number:     string
  license_expiry:     string
  license_image_url?: string | null
  vendor_name:        string
  vendor_contact?:    string | null
  actorId?:           string | null
}

/** What a vendor-supplied assignment needs from the registered driver. */
export interface ExternalDriverForAssignment {
  userId:      string
  driverId:    string
  /** True when the driver has no working passkey, so a setup link must go out. */
  needsInvite: boolean
  firstName:   string | null
  snapshot: {
    vendor_name:           string | null
    vendor_contact:        string | null
    vendor_driver_name:    string
    vendor_driver_license: string | null
    vendor_driver_phone:   string | null
    vendor_driver_email:   string
  }
}

type NameParts = {
  first_name?:  string | null
  middle_name?: string | null
  last_name?:   string | null
  suffix?:      string | null
}

function fullName(u: NameParts): string {
  return [u.first_name, u.middle_name, u.last_name, u.suffix].filter(Boolean).join(' ').trim() || 'Driver'
}

async function findUserByEmail(email: string) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role')
    .eq('email', email)
    .maybeSingle()
  if (error) throw error
  return data as { user_id: string; role: string } | null
}

/**
 * Register a vendor's driver from Driver Management and email them a passkey
 * setup link.
 *
 * Same details as a company driver (name, contact, license number, expiry and
 * photo) so the license expiry reminder and the Driver Management flag cover
 * them too. What differs is the sign-in: no password is ever issued.
 */
export async function createExternalDriver(
  input: CreateExternalDriverInput,
): Promise<{ userId: string; driverId: string }> {
  const email = input.email.trim().toLowerCase()

  const existing = await findUserByEmail(email)
  if (existing) {
    throw new Error(`The email ${email} already belongs to a ${existing.role} account.`)
  }

  // A clear message beats a raw unique violation surfacing in the admin's toast.
  const { data: licenseClash, error: licenseErr } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('license_number', input.license_number)
    .maybeSingle()
  if (licenseErr) throw licenseErr
  if (licenseClash) {
    throw new Error(`License number ${input.license_number} is already registered to another driver.`)
  }

  // The password exists only because auth.users requires one. It is never sent
  // anywhere, never emailed, and loginWithPassword refuses external drivers
  // outright — the passkey is the only way in.
  const unusablePassword = crypto.randomBytes(32).toString('base64url')
  const phone     = input.phone?.trim() || null
  const e164Phone = phone ? (phone.startsWith('0') ? '+63' + phone.slice(1) : phone) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password:      unusablePassword,
    email_confirm: true,
    phone:         e164Phone,
    user_metadata: { role: 'driver', external: true },
  })
  if (authError) throw new Error(`Auth error: ${authError.message}`)

  const userId = authData.user.id
  let driverId: string
  try {
    await createUserWithProfile(
      userId,
      'driver',
      {
        email,
        first_name:  input.first_name,
        last_name:   input.last_name,
        middle_name: input.middle_name ?? null,
        suffix:      input.suffix ?? null,
        phone,
        created_by:  input.actorId ?? null,
        // The opposite of a company driver, and deliberately so. There is no
        // password to change, and a true here would bounce the driver into
        // /change-password after a successful passkey sign-in with no way out.
        must_change_password: false,
      },
      {
        license_number:    input.license_number,
        license_expiry:    input.license_expiry,
        license_image_url: input.license_image_url ?? null,
        is_external:       true,
      },
    )

    // drivers.status 'inactive' keeps them out of the company pool twice over:
    // the is_external filters are the real guard, this is the belt-and-braces
    // one. Nothing on the driver's own side reads drivers.status.
    const { data: profile, error: profileErr } = await supabase
      .from('drivers')
      .update({
        status:         'inactive',
        vendor_name:    input.vendor_name.trim(),
        vendor_contact: input.vendor_contact?.trim() || null,
      })
      .eq('user_id', userId)
      .select('driver_id')
      .maybeSingle()
    if (profileErr) throw profileErr
    if (!profile?.driver_id) throw new Error('Vendor driver profile was not created')
    driverId = profile.driver_id
  } catch (err: any) {
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    throw new Error(`Vendor driver creation failed: ${err.message}`)
  }

  logEvent({
    user_id:     input.actorId,
    log_type:    'user_management',
    action:      'external_driver_provisioned',
    description: `Registered vendor driver ${fullName(input)} (${email}) from ${input.vendor_name}`,
  })

  // Fire-and-forget, like the welcome email for a company driver: the account is
  // made and correct, and a Brevo outage must not undo it. "Resend setup link"
  // on the Vendor tab covers a lost email.
  void issueInvite({ userId, email, firstName: input.first_name, actorId: input.actorId ?? null })
    .catch((err) => console.error('[vendor-driver] failed to send setup link', userId, err))

  return { userId, driverId }
}

/**
 * Load a registered vendor driver for a vendor-supplied assignment.
 *
 * The server reads the driver's details itself rather than trusting what the
 * browser sends, so the delivery snapshot always matches the record.
 */
export async function findExternalDriverForAssignment(userId: string): Promise<ExternalDriverForAssignment> {
  const { data, error } = await supabase
    .from('users')
    .select(`
      user_id, email, first_name, middle_name, last_name, suffix, phone, role, status,
      drivers ( driver_id, is_external, license_number, vendor_name, vendor_contact )
    `)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error

  const row: any = data
  const profile  = Array.isArray(row?.drivers) ? row.drivers[0] : row?.drivers
  if (!row || row.role !== 'driver' || !profile?.driver_id) throw new Error('Vendor driver not found')
  // A company driver reached through the vendor path would sidestep every
  // availability and BLOWBAGETS check the company path enforces.
  if (profile.is_external !== true) {
    throw new Error('This is a company driver. Assign them through Company fleet instead.')
  }
  if (row.status === 'archived') throw new Error('This vendor driver was deleted.')
  if (row.status !== 'active') {
    throw new Error('This vendor driver\'s access is turned off. Restore it in Driver Management first.')
  }

  const active = await WebauthnModel.listCredentialsForUser(row.user_id)
  return {
    userId:      row.user_id,
    driverId:    profile.driver_id,
    needsInvite: active.length === 0,
    firstName:   row.first_name ?? null,
    snapshot: {
      vendor_name:           profile.vendor_name ?? null,
      vendor_contact:        profile.vendor_contact ?? null,
      vendor_driver_name:    fullName(row),
      vendor_driver_license: profile.license_number ?? null,
      vendor_driver_phone:   row.phone ?? null,
      vendor_driver_email:   row.email,
    },
  }
}


/**
 * Put a switched-off account back to active, lockout counters and auth ban
 * included — the same fields activateUserWithUnban clears, so every way back in
 * behaves the same.
 */
async function reactivateAccount(userId: string): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({
      status:                'active',
      locked_until:          null,
      failed_login_attempts: 0,
      lockup_count:          0,
    })
    .eq('user_id', userId)
  if (error) throw error
  await unbanAuthUser(userId)
}

// ---------------------------------------------------------------------------
// Invites

/**
 * Mint and send an enrolment invite.
 *
 * Any outstanding invite for the same driver is revoked first, so there is only
 * ever one live link per person. Without that, a re-invite would leave the older
 * link working and two valid setup links in one inbox is exactly the confusion
 * that gets one of them forwarded.
 *
 * Existing passkeys are deliberately NOT revoked: a driver who has a working
 * phone and is simply being given a second device should not lose the first.
 * Revocation is its own action.
 */
export async function issueInvite(params: {
  userId:     string
  email:      string
  bookingId?: string | null
  bookingRef?: string | null
  firstName?: string | null
  actorId?:   string | null
}): Promise<void> {
  await InviteModel.revokeOpenInvitesForUser(params.userId)

  const token = generateInviteToken()
  await InviteModel.createInvite({
    userId:    params.userId,
    bookingId: params.bookingId ?? null,
    email:     params.email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    sentBy:    params.actorId ?? null,
  })

  // buildDriverSetupUrl throws when no app base URL is configured. Let it: an
  // invite email whose entire content is a link must not go out with a broken
  // one, and the invite row above is revoked by the next issue anyway.
  await sendDriverEnrollmentEmail({
    to:             params.email,
    firstName:      params.firstName ?? null,
    setupUrl:       buildDriverSetupUrl(token),
    expiresInHours: Math.round(INVITE_TTL_MS / (60 * 60 * 1000)),
    bookingRef:     params.bookingRef ?? null,
  })

  logEvent({
    user_id:     params.actorId,
    log_type:    'user_management',
    action:      'external_driver_invited',
    description: `Passkey setup link sent to ${params.email}`,
  })
}

/** Re-invite, for a lost or replaced phone. Leaves any working passkey alone. */
export async function reinvite(userId: string, actorId?: string | null): Promise<void> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, status, drivers ( is_external )')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Driver not found')

  const profile = Array.isArray(data.drivers) ? data.drivers[0] : data.drivers
  if (profile?.is_external !== true) {
    throw new Error('Only vendor-supplied drivers use passkey setup links.')
  }
  if (data.status !== 'active') {
    throw new Error('This driver\'s access was revoked. Use "Restore access" to turn it back on and send a new setup link.')
  }

  await issueInvite({
    userId:    data.user_id,
    email:     data.email,
    firstName: data.first_name,
    actorId,
  })
}

/**
 * Offboard an external driver.
 *
 * Revokes every passkey, kills any live session, cancels outstanding invites and
 * deactivates the account. What it does NOT touch is the delivery's vendor
 * snapshot or vendor_driver_user_id — that is the record of who drove, and it
 * outlives the access.
 */
export async function revokeExternalDriver(
  userId:  string,
  actorId?: string | null,
  reason   = 'Offboarded',
): Promise<{ credentialsRevoked: number }> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, drivers ( driver_id, is_external )')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Driver not found')

  const profile = Array.isArray(data.drivers) ? data.drivers[0] : data.drivers
  if (profile?.is_external !== true) {
    throw new Error('This is not a vendor-supplied driver.')
  }

  const credentialsRevoked = await WebauthnModel.revokeAllForUser(userId, actorId ?? null, reason)
  await InviteModel.revokeOpenInvitesForUser(userId)
  await AuthModel.revokeAllUserSessions(userId, 'credentials_revoked')

  const { error: userErr } = await supabase
    .from('users')
    .update({ status: 'inactive' })
    .eq('user_id', userId)
  if (userErr) throw userErr

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'external_driver_revoked',
    description: `Revoked app access for ${data.email} (${credentialsRevoked} passkey(s)) — ${reason}`,
  })

  return { credentialsRevoked }
}

/**
 * Undo revokeExternalDriver: reactivate the account and send a fresh setup link.
 *
 * The old passkeys stay revoked — revocation is final for a credential, because
 * the phone that held it may no longer be the driver's. The driver enrols again,
 * and since a revoked credential is never in the exclusion list, a phone still
 * holding the stale copy simply replaces it.
 */
export async function restoreExternalDriver(userId: string, actorId?: string | null): Promise<void> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, status, drivers ( is_external )')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Driver not found')

  const profile = Array.isArray(data.drivers) ? data.drivers[0] : data.drivers
  if (profile?.is_external !== true) {
    throw new Error('This is not a vendor-supplied driver.')
  }
  if (data.status === 'active') {
    throw new Error('This driver\'s access is already active. Use "Resend setup link" instead.')
  }

  await reactivateAccount(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'external_driver_restored',
    description: `Restored app access for ${data.email}`,
  })

  await issueInvite({
    userId:    data.user_id,
    email:     data.email,
    firstName: data.first_name,
    actorId,
  })
}

/**
 * The vendor-driver roster for User Management, each row carrying its access
 * state so the list can offer the right action without a request per row.
 */
export async function listExternalDrivers() {
  const users = await DriverModel.findAllExternal()
  const ids   = users.map((u: any) => u.user_id as string)

  const [credentials, invites] = await Promise.all([
    WebauthnModel.listActiveCredentialsForUsers(ids),
    InviteModel.listForUsers(ids),
  ])

  const now = new Date()
  return users.map((u: any) => {
    const mine       = credentials.filter((c) => c.user_id === u.user_id)
    const openInvite = invites.find(
      (i) => i.user_id === u.user_id && i.status === 'sent' && new Date(i.expires_at) > now,
    )
    return {
      ...u,
      access: {
        passkey_count:     mine.length,
        last_used_at:      mine.map((c) => c.last_used_at).filter(Boolean).sort().pop() ?? null,
        invite_pending:    !!openInvite,
        invite_expires_at: openInvite?.expires_at ?? null,
        enrolled:          mine.length > 0,
        account_active:    u.status === 'active',
      },
    }
  })
}

/** What the admin panel shows next to a vendor-supplied assignment. */
export async function externalDriverAccessStatus(userId: string) {
  const [credentials, invites, account] = await Promise.all([
    WebauthnModel.listCredentialsForUser(userId),
    InviteModel.listForUser(userId),
    supabase.from('users').select('status').eq('user_id', userId).maybeSingle(),
  ])
  if (account.error) throw account.error

  const openInvite = invites.find((i) => i.status === 'sent' && new Date(i.expires_at) > new Date())

  return {
    passkey_count: credentials.length,
    last_used_at:  credentials
      .map((c) => c.last_used_at)
      .filter(Boolean)
      .sort()
      .pop() ?? null,
    invite_pending:    !!openInvite,
    invite_expires_at: openInvite?.expires_at ?? null,
    enrolled:          credentials.length > 0,
    // False after a revoke. The panel swaps its buttons for "Restore access",
    // because a setup link cannot be sent to an inactive account.
    account_active:    account.data?.status === 'active',
  }
}
