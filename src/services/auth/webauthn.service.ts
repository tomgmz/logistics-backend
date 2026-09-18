import crypto from 'node:crypto'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import {
  RP_ID,
  RP_NAME,
  ALLOWED_ORIGINS,
  CHALLENGE_TTL_MS,
  MAX_INVITE_ATTEMPTS,
  assertPasskeyConfigured,
} from '../../lib/webauthn-config.js'
import * as WebauthnModel from '../../models/auth/webauthn.model.js'
import * as InviteModel from '../../models/auth/driver-invite.model.js'
import { hashToken, issueVerifiedSession } from './auth.service.js'
import type { AuthResponse } from '../../types/auth.types.js'

/**
 * Passkey registration and authentication.
 *
 * Verification is done by @simplewebauthn/server; what this file owns is
 * everything around it — which challenges are live, which invite authorises an
 * enrolment, what a counter regression means, and where a verified ceremony
 * hands off to the ordinary session machinery.
 */

/** Deliberately indistinguishable: expired, consumed, revoked and never-existed all look the same. */
function invalidInvite(): Error {
  const err = new Error('This setup link is invalid or has expired. Ask your dispatcher to send a new one.')
  ;(err as any).code = 'ENROLLMENT_TOKEN_INVALID'
  return err
}

async function loadUser(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, last_name, role, status, must_change_password')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Enrolment

export interface InvitePreview {
  valid:       boolean
  firstName?:  string | null
  emailMasked?: string
  expiresAt?:  string
}

/** Mask all but the first character and the domain: enough to recognise, not enough to harvest. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '•••'
  const head = local.slice(0, 1)
  return `${head}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`
}

/**
 * Check an invite before the app renders its "set up sign-in" button.
 *
 * Checking first means an expired link says so immediately, rather than after
 * the driver has been through a biometric prompt.
 */
export async function verifyInvite(token: string): Promise<InvitePreview> {
  const invite = await InviteModel.findLiveByTokenHash(hashToken(token))
  if (!invite) return { valid: false }

  const user = await loadUser(invite.user_id)
  if (!user || user.status !== 'active') return { valid: false }

  return {
    valid:       true,
    firstName:   user.first_name,
    emailMasked: maskEmail(invite.email),
    expiresAt:   invite.expires_at,
  }
}

export async function startRegistration(token: string, ip?: string | null) {
  assertPasskeyConfigured()

  const invite = await InviteModel.findLiveByTokenHash(hashToken(token))
  if (!invite) throw invalidInvite()

  await InviteModel.recordAttempt(invite.invite_id, MAX_INVITE_ATTEMPTS)

  const user = await loadUser(invite.user_id)
  if (!user || user.status !== 'active') throw invalidInvite()

  const handle   = await WebauthnModel.ensureUserHandle(user.user_id)
  const existing = await WebauthnModel.listCredentialsForUser(user.user_id)

  const options = await generateRegistrationOptions({
    rpName:          RP_NAME,
    rpID:            RP_ID,
    userID:          handle,
    userName:        user.email,
    userDisplayName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
    // No attestation: we are not verifying authenticator provenance, and asking
    // for it would add a privacy prompt on some platforms for information we
    // would not act on.
    attestationType: 'none',
    // Already-enrolled credentials are excluded so re-running setup on the same
    // phone gives a clear "already registered" from the platform instead of
    // silently creating a duplicate.
    excludeCredentials: existing.map((c) => ({
      id:         c.credential_id,
      transports: c.transports as any,
    })),
    authenticatorSelection: {
      // Discoverable, so sign-in needs no email typed — which also removes the
      // account-enumeration surface entirely.
      residentKey:       'required',
      // The half of the MFA claim that makes a passkey more than "something you
      // have". Enforced again at verification; setting it only here would be a
      // client-side hint a hostile client is free to ignore.
      userVerification:  'required',
      authenticatorAttachment: 'platform',
    },
    timeout: 60_000,
  })

  await WebauthnModel.createChallenge({
    challengeHash: hashToken(options.challenge),
    purpose:       'registration',
    userId:        user.user_id,
    expiresAt:     new Date(Date.now() + CHALLENGE_TTL_MS),
    ip,
  })

  return options
}

export async function finishRegistration(
  token:      string,
  response:   any,
  deviceInfo?: string,
  deviceLabel?: string | null,
): Promise<AuthResponse> {
  assertPasskeyConfigured()

  const invite = await InviteModel.findLiveByTokenHash(hashToken(token))
  if (!invite) throw invalidInvite()

  const user = await loadUser(invite.user_id)
  if (!user || user.status !== 'active') throw invalidInvite()

  // Recover the challenge from the client data and burn it. Doing it this way
  // round means a response carrying someone else's or a replayed challenge finds
  // nothing to consume.
  const clientData = JSON.parse(
    Buffer.from(response?.response?.clientDataJSON ?? '', 'base64url').toString('utf8'),
  )
  const consumed = await WebauthnModel.consumeChallenge(
    hashToken(clientData.challenge),
    'registration',
  )
  if (!consumed || consumed.user_id !== user.user_id) {
    throw new Error('This setup attempt expired. Please start again.')
  }

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: clientData.challenge,
    expectedOrigin:    ALLOWED_ORIGINS,
    expectedRPID:      RP_ID,
    requireUserVerification: true,
  })

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Could not verify the passkey. Please try again.')
  }

  const info = verification.registrationInfo
  await WebauthnModel.insertCredential({
    userId:         user.user_id,
    credentialId:   info.credential.id,
    publicKey:      info.credential.publicKey,
    counter:        info.credential.counter,
    transports:     (info.credential.transports ?? []) as string[],
    aaguid:         info.aaguid ?? null,
    // Recorded so a later lockout can be triaged: a backed-up credential
    // survives a new phone, a device-bound one does not.
    backupEligible: info.credentialBackedUp !== undefined ? info.credentialDeviceType === 'multiDevice' : false,
    backupState:    info.credentialBackedUp ?? false,
    rpId:           RP_ID,
    deviceLabel:    deviceLabel ?? null,
  })

  await InviteModel.consumeInvite(invite.invite_id)

  logEvent({
    user_id:     user.user_id,
    log_type:    'user_activity',
    action:      'passkey_registered',
    description: `Passkey enrolled for ${user.email}${deviceLabel ? ` on ${deviceLabel}` : ''}`,
  })

  // Signed in on the spot. The driver has just proved a single-use emailed token
  // and completed a user-verified registration; a second sign-in immediately
  // afterwards would be friction with no security value.
  return issueVerifiedSession(user as any, deviceInfo)
}

// ---------------------------------------------------------------------------
// Authentication

export async function startAuthentication(ip?: string | null) {
  assertPasskeyConfigured()

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    // Empty: discoverable credentials mean the device offers what it has and the
    // server learns who is signing in only from the assertion. No email is sent,
    // so there is nothing here to enumerate against.
    allowCredentials: [],
    userVerification: 'required',
    timeout: 60_000,
  })

  await WebauthnModel.createChallenge({
    challengeHash: hashToken(options.challenge),
    purpose:       'authentication',
    userId:        null,
    expiresAt:     new Date(Date.now() + CHALLENGE_TTL_MS),
    ip,
  })

  return options
}

export async function finishAuthentication(
  response:    any,
  deviceInfo?: string,
): Promise<AuthResponse> {
  assertPasskeyConfigured()

  const failed = () => new Error('Could not sign you in with that passkey.')

  const clientData = JSON.parse(
    Buffer.from(response?.response?.clientDataJSON ?? '', 'base64url').toString('utf8'),
  )
  const consumed = await WebauthnModel.consumeChallenge(
    hashToken(clientData.challenge),
    'authentication',
  )
  if (!consumed) throw failed()

  const credential = await WebauthnModel.findCredentialById(response?.id)
  if (!credential) throw failed()

  if (credential.revoked_at) {
    logEvent({
      user_id:     credential.user_id,
      log_type:    'user_activity',
      action:      'passkey_auth_failed',
      description: `Revoked passkey presented (credential ${credential.credential_id.slice(0, 12)}…)`,
    })
    throw new Error('This passkey has been revoked. Ask your dispatcher to send a new setup link.')
  }

  const user = await loadUser(credential.user_id)
  if (!user) throw failed()
  if (user.status !== 'active') {
    throw new Error('This account is no longer active. Please contact your dispatcher.')
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: clientData.challenge,
    expectedOrigin:    ALLOWED_ORIGINS,
    expectedRPID:      RP_ID,
    requireUserVerification: true,
    credential: {
      id:        credential.credential_id,
      publicKey: WebauthnModel.publicKeyOf(credential),
      counter:   Number(credential.counter),
      transports: credential.transports as any,
    },
  })

  if (!verification.verified) {
    logEvent({
      user_id:     user.user_id,
      log_type:    'user_activity',
      action:      'passkey_auth_failed',
      description: `Passkey assertion failed verification for ${user.email}`,
    })
    throw failed()
  }

  const stored     = Number(credential.counter)
  const newCounter = verification.authenticationInfo.newCounter

  // Counter handling, and the branch order matters.
  //
  // A synced passkey (Google Password Manager, iCloud Keychain) reports 0 for
  // ever, because there is no single authenticator to keep a count. That is the
  // NORMAL case for these drivers, not an edge case — treating 0/0 as a
  // regression would lock out every driver on their second sign-in.
  //
  // A stored counter above zero means a device-bound authenticator that does
  // count, and there a value that fails to advance means the credential has been
  // cloned.
  if (stored > 0 && newCounter <= stored) {
    await WebauthnModel.revokeCredential(
      credential.credential_pk,
      null,
      'Signature counter regression — possible cloned authenticator',
    )
    logEvent({
      user_id:     user.user_id,
      log_type:    'user_activity',
      action:      'passkey_counter_regression',
      description:
        `Counter regression for ${user.email}: stored ${stored}, presented ${newCounter}. ` +
        `Credential revoked.`,
    })
    throw new Error('This passkey could not be trusted and has been disabled. Contact your dispatcher.')
  }

  if (newCounter !== stored) {
    await WebauthnModel.recordUse(credential.credential_pk, newCounter)
  } else {
    await WebauthnModel.recordUse(credential.credential_pk, stored)
  }

  logEvent({
    user_id:     user.user_id,
    log_type:    'user_activity',
    action:      'passkey_auth_success',
    description: `Passkey sign-in for ${user.email}`,
  })

  return issueVerifiedSession(user as any, deviceInfo)
}

// ---------------------------------------------------------------------------
// Self-service listing / removal

export async function listMyPasskeys(userId: string) {
  const rows = await WebauthnModel.listCredentialsForUser(userId)
  return rows.map((r) => ({
    credential_pk: r.credential_pk,
    device_label:  r.device_label,
    backed_up:     r.backup_state,
    last_used_at:  r.last_used_at,
  }))
}

export async function removeMyPasskey(userId: string, credentialPk: string): Promise<void> {
  const rows = await WebauthnModel.listCredentialsForUser(userId)
  const target = rows.find((r) => r.credential_pk === credentialPk)
  if (!target) throw new Error('Passkey not found')

  // Removing the only passkey would lock the driver out of an account that has
  // no other way in, and the re-invite has to come from an admin.
  if (rows.length === 1) {
    throw new Error('This is your only passkey. Add another device before removing this one.')
  }

  await WebauthnModel.revokeCredential(credentialPk, userId, 'Removed by the driver')
}

/** Mint an enrolment token. Only the hash is stored; the plaintext goes in the email and nowhere else. */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}
