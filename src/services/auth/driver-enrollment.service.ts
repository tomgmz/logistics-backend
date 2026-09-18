import crypto from 'node:crypto'
import { supabase } from '../../lib/supabase.js'
import { createUserWithProfile } from '../../lib/user-provisioning.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'
import { logEvent } from '../../lib/log-event.js'
import { buildDriverSetupUrl, sendDriverEnrollmentEmail } from '../../lib/brevo-mailer.js'
import { INVITE_TTL_MS } from '../../lib/webauthn-config.js'
import { hashToken } from './auth.service.js'
import { generateInviteToken } from './webauthn.service.js'
import * as InviteModel from '../../models/auth/driver-invite.model.js'
import * as WebauthnModel from '../../models/auth/webauthn.model.js'
import * as AuthModel from '../../models/auth/auth.model.js'

/**
 * Accounts for outside-vendor drivers.
 *
 * A vendor-supplied assignment is still recorded as a snapshot on the delivery —
 * that remains the record of who drove. What this adds is an optional, minimal
 * account so the driver can actually open the app and do the job: see the run
 * sheet, get the assignment push, record proof at each stop.
 *
 * The account is deliberately thin. It is role='driver' (access is scoped by
 * driver_assignments, not by role string), it is flagged is_external so it can
 * never be offered as company crew, and it has no usable password — the only way
 * in is a passkey the driver enrols on their own phone.
 */

export interface ProvisionExternalDriverInput {
  email:     string
  name:      string
  license?:  string | null
  phone?:    string | null
  actorId?:  string | null
}

export interface ProvisionedExternalDriver {
  userId:   string
  driverId: string
  /** False when an existing account was reused — a repeat subcontractor. */
  created:  boolean
}

/**
 * Split a single free-text driver name into the first/last the users table wants.
 *
 * Ops types one field ("Juan Dela Cruz"), so this is a guess by definition. The
 * last whitespace-separated token becomes the surname and everything before it
 * the given name, which is right for the common cases and harmless when wrong —
 * nothing keys off these, they are display only.
 */
function splitName(full: string): { first: string; last: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: 'Driver', last: null }
  if (parts.length === 1) return { first: parts[0], last: null }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

/**
 * drivers.license_number is NOT NULL and UNIQUE, but ops is not required to
 * capture a licence for a vendor driver. Mint a clearly-synthetic placeholder in
 * that case rather than blocking the assignment — it is visibly not a licence
 * number, so nobody mistakes it for one later.
 */
function syntheticLicense(): string {
  return `EXT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

async function findUserByEmail(email: string) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role, status, drivers ( driver_id, is_external )')
    .eq('email', email)
    .maybeSingle()
  if (error) throw error
  return data as
    | { user_id: string; role: string; status: string | null; drivers: any }
    | null
}

/**
 * Create (or find) the account for a vendor's driver.
 *
 * Reuse is intentional: the same subcontractor often comes back on a later
 * booking, and minting a second account would mean a second enrolment and a
 * second passkey for the same person.
 */
export async function provisionExternalDriver(
  input: ProvisionExternalDriverInput,
): Promise<ProvisionedExternalDriver> {
  const email = input.email.trim().toLowerCase()

  const existing = await findUserByEmail(email)
  if (existing) {
    // Never silently attach a vendor driver to a staff or client account. If the
    // address is already spoken for by anything but a driver, that is either a
    // typo or someone trying to widen their own access — say so out loud.
    if (existing.role !== 'driver') {
      throw new Error(
        `The email ${email} already belongs to a ${existing.role} account. ` +
        `Use a different address for the vendor driver.`,
      )
    }
    const profile = Array.isArray(existing.drivers) ? existing.drivers[0] : existing.drivers
    if (!profile?.driver_id) {
      throw new Error(`The account for ${email} is missing its driver profile; fix it before assigning.`)
    }
    // A company driver reached through the vendor path would sidestep every
    // availability and BLOWBAGETS check the company path enforces.
    if (profile.is_external !== true) {
      throw new Error(
        `${email} is a company driver. Assign them through the company path instead of as vendor-supplied.`,
      )
    }

    // An archived account is reactivated rather than duplicated: same person,
    // same passkeys, back on the road.
    if (existing.status !== 'active') {
      const { error } = await supabase
        .from('users')
        .update({ status: 'active' })
        .eq('user_id', existing.user_id)
      if (error) throw error
    }

    return { userId: existing.user_id, driverId: profile.driver_id, created: false }
  }

  const { first, last } = splitName(input.name)
  const license = input.license?.trim() || syntheticLicense()

  // A licence number already on file belongs to someone else — most likely this
  // vendor driver moonlighting under a company record, possibly a typo. Either
  // way it cannot be written twice, and a clear message beats a raw unique
  // violation surfacing in the operator's toast.
  const { data: licenseClash, error: licenseErr } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('license_number', license)
    .maybeSingle()
  if (licenseErr) throw licenseErr
  if (licenseClash) {
    throw new Error(`Licence number ${license} is already registered to another driver.`)
  }

  // The password exists only because auth.users requires one. It is never sent
  // anywhere, never emailed, and loginWithPassword refuses external drivers
  // outright — the passkey is the only way in.
  const unusablePassword = crypto.randomBytes(32).toString('base64url')
  const e164Phone = input.phone?.trim()
    ? input.phone.trim().startsWith('0')
      ? '+63' + input.phone.trim().slice(1)
      : input.phone.trim()
    : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password:      unusablePassword,
    email_confirm: true,
    phone:         e164Phone,
    user_metadata: { role: 'driver', external: true },
  })
  if (authError) throw new Error(`Auth error: ${authError.message}`)

  const userId = authData.user.id
  try {
    await createUserWithProfile(
      userId,
      'driver',
      {
        email,
        first_name: first,
        last_name:  last,
        phone:      input.phone ?? null,
        created_by: input.actorId ?? null,
        // The opposite of createDriver, and deliberately so. There is no password
        // to change, and a true here would bounce the driver into
        // /change-password after a successful passkey sign-in with no way out.
        must_change_password: false,
      },
      {
        license_number: license,
        // No expiry: ops captures none for a vendor driver, and the column now
        // permits NULL for external drivers only.
        license_expiry: null,
        is_external:    true,
      },
    )
  } catch (err: any) {
    const ok = await deleteAuthUserSafely(userId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user ID:', userId)
    throw new Error(`External driver creation failed: ${err.message}`)
  }

  const { data: created, error: fetchErr } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (fetchErr) throw fetchErr
  if (!created?.driver_id) throw new Error('External driver profile was not created')

  // Keep them out of the company pool twice over: the is_external filters are the
  // real guard, this is the belt-and-braces one. Nothing on the driver's own side
  // reads drivers.status, so it costs them nothing.
  const { error: statusErr } = await supabase
    .from('drivers')
    .update({ status: 'inactive' })
    .eq('driver_id', created.driver_id)
  if (statusErr) throw statusErr

  logEvent({
    user_id:     input.actorId,
    log_type:    'user_activity',
    action:      'external_driver_provisioned',
    description: `Provisioned app access for vendor driver ${input.name} (${email})`,
  })

  return { userId, driverId: created.driver_id, created: true }
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
    log_type:    'user_activity',
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
    throw new Error('This account is not active. Reactivate it before sending a setup link.')
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
  await AuthModel.revokeAllUserSessions(userId)

  const { error: userErr } = await supabase
    .from('users')
    .update({ status: 'inactive' })
    .eq('user_id', userId)
  if (userErr) throw userErr

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'external_driver_revoked',
    description: `Revoked app access for ${data.email} (${credentialsRevoked} passkey(s)) — ${reason}`,
  })

  return { credentialsRevoked }
}

/** What the admin panel shows next to a vendor-supplied assignment. */
export async function externalDriverAccessStatus(userId: string) {
  const [credentials, invites] = await Promise.all([
    WebauthnModel.listCredentialsForUser(userId),
    InviteModel.listForUser(userId),
  ])

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
  }
}
