import { supabase } from '../../lib/supabase.js'

export interface DriverInviteRow {
  invite_id:   string
  user_id:     string
  booking_id:  string | null
  email:       string
  expires_at:  string
  status:      'sent' | 'consumed' | 'expired' | 'revoked'
  attempts:    number
  created_at:  string
}

export async function createInvite(params: {
  userId:    string
  bookingId?: string | null
  email:     string
  tokenHash: string
  expiresAt: Date
  sentBy?:   string | null
}): Promise<DriverInviteRow> {
  const { data, error } = await supabase
    .from('driver_enrollment_invites')
    .insert({
      user_id:    params.userId,
      booking_id: params.bookingId ?? null,
      email:      params.email,
      token_hash: params.tokenHash,
      expires_at: params.expiresAt.toISOString(),
      sent_by:    params.sentBy ?? null,
    })
    .select('*')
    .single()

  if (error) throw error
  return data as DriverInviteRow
}

/** A 'sent', unexpired invite, or null. Never reveals which of those it failed on. */
export async function findLiveByTokenHash(tokenHash: string): Promise<DriverInviteRow | null> {
  const { data, error } = await supabase
    .from('driver_enrollment_invites')
    .select('*')
    .eq('token_hash', tokenHash)
    .eq('status', 'sent')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as DriverInviteRow | null
}

/**
 * Count an attempt against an invite, and tear it down once it has had too many.
 *
 * A 256-bit token is not guessable, so this is not really brute-force defence —
 * it is there to stop a replay storm quietly hammering the endpoint, and to make
 * a misbehaving client visible rather than silent.
 */
export async function recordAttempt(inviteId: string, max: number): Promise<number> {
  const { data, error } = await supabase
    .from('driver_enrollment_invites')
    .select('attempts')
    .eq('invite_id', inviteId)
    .maybeSingle()
  if (error) throw error

  const attempts = (data?.attempts ?? 0) + 1
  const update: Record<string, unknown> = { attempts }
  if (attempts >= max) update.status = 'revoked'

  const { error: updateErr } = await supabase
    .from('driver_enrollment_invites')
    .update(update)
    .eq('invite_id', inviteId)
  if (updateErr) throw updateErr

  return attempts
}

/**
 * Burn the invite. Conditional on it still being 'sent', so a double submit
 * cannot enrol two credentials off one invite.
 */
export async function consumeInvite(inviteId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('driver_enrollment_invites')
    .update({ status: 'consumed', consumed_at: new Date().toISOString() })
    .eq('invite_id', inviteId)
    .eq('status', 'sent')
    .select('invite_id')
    .maybeSingle()

  if (error) throw error
  return !!data
}

/** Invalidate any outstanding invites — on re-invite, and on offboarding. */
export async function revokeOpenInvitesForUser(userId: string): Promise<void> {
  const { error } = await supabase
    .from('driver_enrollment_invites')
    .update({ status: 'revoked' })
    .eq('user_id', userId)
    .eq('status', 'sent')
  if (error) throw error
}

export async function listForUser(userId: string): Promise<DriverInviteRow[]> {
  const { data, error } = await supabase
    .from('driver_enrollment_invites')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as DriverInviteRow[]
}
