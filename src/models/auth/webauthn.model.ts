import crypto from 'node:crypto'
import { supabase } from '../../lib/supabase.js'

export interface WebauthnCredentialRow {
  credential_pk:   string
  user_id:         string
  credential_id:   string
  public_key:      string   // hex, as Postgres returns bytea via PostgREST ('\x...')
  counter:         number
  transports:      string[]
  aaguid:          string | null
  backup_eligible: boolean
  backup_state:    boolean
  rp_id:           string
  device_label:    string | null
  last_used_at:    string | null
  revoked_at:      string | null
}

// PostgREST hands bytea back as the Postgres hex-escape form ('\x6b6579...'),
// and wants the same form on the way in. Keeping the conversion in one place
// stops a stray Buffer being written as its JSON representation, which would
// store the string "{"type":"Buffer"...}" and fail verification much later.
function toBytea(buf: Uint8Array): string {
  return '\\x' + Buffer.from(buf).toString('hex')
}

// Uint8Array.from rather than new Uint8Array(buffer): the latter keeps the
// Buffer's ArrayBufferLike backing, which does not satisfy the Uint8Array<ArrayBuffer>
// the WebAuthn types ask for.
function fromBytea(value: string | null): Uint8Array<ArrayBuffer> {
  if (!value) return Uint8Array.from([])
  const hex = value.startsWith('\\x') ? value.slice(2) : value
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

export function publicKeyOf(row: WebauthnCredentialRow): Uint8Array<ArrayBuffer> {
  return fromBytea(row.public_key)
}

/**
 * The account's WebAuthn user handle, created on first use.
 *
 * Random and opaque on purpose: the handle is returned by the authenticator in
 * every discoverable-credential assertion, so a user_id or an email here would
 * be handing out identifiers to anything that can prompt for a passkey.
 */
export async function ensureUserHandle(userId: string): Promise<Uint8Array<ArrayBuffer>> {
  const { data, error } = await supabase
    .from('users')
    .select('webauthn_user_handle')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error

  if (data?.webauthn_user_handle) return fromBytea(data.webauthn_user_handle)

  const handle = Uint8Array.from(crypto.randomBytes(32))
  const { error: updateErr } = await supabase
    .from('users')
    .update({ webauthn_user_handle: toBytea(handle) })
    .eq('user_id', userId)
  if (updateErr) throw updateErr

  return handle
}

export async function findUserByHandle(handle: Uint8Array) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, last_name, role, status, must_change_password')
    .eq('webauthn_user_handle', toBytea(handle))
    .maybeSingle()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Challenges

/**
 * Record a challenge and hand back nothing — the plaintext stays with the
 * caller, only its hash is persisted, exactly as session and reset tokens are
 * handled.
 */
export async function createChallenge(params: {
  challengeHash: string
  purpose:       'registration' | 'authentication'
  userId?:       string | null
  expiresAt:     Date
}): Promise<void> {
  const { error } = await supabase.from('webauthn_challenges').insert({
    challenge_hash: params.challengeHash,
    purpose:        params.purpose,
    user_id:        params.userId ?? null,
    expires_at:     params.expiresAt.toISOString(),
  })
  if (error) throw error
}

/**
 * Burn a challenge, returning it only if it was live.
 *
 * Written as a conditional update rather than read-then-write so that two
 * concurrent verifications of the same challenge cannot both succeed — Postgres
 * settles the race, not the order the two requests happen to interleave in Node.
 */
export async function consumeChallenge(
  challengeHash: string,
  purpose:       'registration' | 'authentication',
): Promise<{ user_id: string | null } | null> {
  const { data, error } = await supabase
    .from('webauthn_challenges')
    .update({ consumed_at: new Date().toISOString() })
    .eq('challenge_hash', challengeHash)
    .eq('purpose', purpose)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('user_id')
    .maybeSingle()

  if (error) throw error
  return data ?? null
}

/** Housekeeping for challenges nobody ever completed. */
export async function purgeExpiredChallenges(): Promise<void> {
  const { error } = await supabase
    .from('webauthn_challenges')
    .delete()
    .lt('expires_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Credentials

export async function insertCredential(params: {
  userId:         string
  credentialId:   string
  publicKey:      Uint8Array
  counter:        number
  transports:     string[]
  aaguid?:        string | null
  backupEligible: boolean
  backupState:    boolean
  rpId:           string
  deviceLabel?:   string | null
}): Promise<void> {
  const { error } = await supabase.from('webauthn_credentials').insert({
    user_id:         params.userId,
    credential_id:   params.credentialId,
    public_key:      toBytea(params.publicKey),
    counter:         params.counter,
    transports:      params.transports,
    aaguid:          params.aaguid ?? null,
    backup_eligible: params.backupEligible,
    backup_state:    params.backupState,
    rp_id:           params.rpId,
    device_label:    params.deviceLabel ?? null,
  })
  if (error) throw error
}

/** Looks up by credential ID regardless of revocation, so a revoked one can say so. */
export async function findCredentialById(credentialId: string): Promise<WebauthnCredentialRow | null> {
  const { data, error } = await supabase
    .from('webauthn_credentials')
    .select('*')
    .eq('credential_id', credentialId)
    .maybeSingle()
  if (error) throw error
  return (data ?? null) as WebauthnCredentialRow | null
}

export async function listCredentialsForUser(
  userId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<WebauthnCredentialRow[]> {
  let query = supabase.from('webauthn_credentials').select('*').eq('user_id', userId)
  if (!opts.includeRevoked) query = query.is('revoked_at', null)

  const { data, error } = await query.order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as WebauthnCredentialRow[]
}

export async function recordUse(credentialPk: string, counter: number): Promise<void> {
  const { error } = await supabase
    .from('webauthn_credentials')
    .update({ counter, last_used_at: new Date().toISOString() })
    .eq('credential_pk', credentialPk)
  if (error) throw error
}

export async function revokeCredential(
  credentialPk: string,
  revokedBy:    string | null,
  reason:       string,
): Promise<void> {
  const { error } = await supabase
    .from('webauthn_credentials')
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy, revoked_reason: reason })
    .eq('credential_pk', credentialPk)
    .is('revoked_at', null)
  if (error) throw error
}

export async function revokeAllForUser(
  userId:    string,
  revokedBy: string | null,
  reason:    string,
): Promise<number> {
  const { data, error } = await supabase
    .from('webauthn_credentials')
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy, revoked_reason: reason })
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('credential_pk')
  if (error) throw error
  return (data ?? []).length
}
