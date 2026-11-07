import { supabase } from './supabase.js'
import { phDay, asDay } from './ph-date.js'
import { daysBetween } from './registration-expiry.js'

/**
 * A client's contract with 8338 (clients.contract_valid_until = the last valid
 * day, Philippine time). The user's rule, 2026-11-07:
 *
 *   ok      — on or before the date, or no date on file (older clients): full use
 *   grace   — 1 to 7 days after: may sign in and read everything, may NOT book
 *             (create, edit a pending booking, resubmit); a banner says it ended
 *   ended   — from day 8: cannot sign in at all, until a new date is saved
 *
 * Bookings made before the end carry on (approval, delivery, the client's
 * confirmation); only new booking work is refused.
 * Mirrored in logistics-frontend/src/lib/contract-status.ts.
 */
export const CONTRACT_GRACE_DAYS = 7

export type ContractState = 'ok' | 'grace' | 'ended'

export interface ContractStatus {
  state:          ContractState
  /** `YYYY-MM-DD`, null when none is on file. */
  valid_until:    string | null
  /** Last day the client can still sign in (valid_until + 7), null when none. */
  access_until:   string | null
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

export function contractStatus(validUntil: unknown, today: string = phDay()): ContractStatus {
  const valid_until = asDay(validUntil as string | Date | null)
  if (!valid_until) return { state: 'ok', valid_until: null, access_until: null }
  const access_until = addDays(valid_until, CONTRACT_GRACE_DAYS)
  const after = daysBetween(valid_until, today)
  const state: ContractState = after <= 0 ? 'ok' : after <= CONTRACT_GRACE_DAYS ? 'grace' : 'ended'
  return { state, valid_until, access_until }
}

/** The contract status of a client account, by user id. */
export async function contractStatusForUser(userId: string): Promise<ContractStatus> {
  const { data, error } = await supabase
    .from('clients')
    .select('contract_valid_until')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return contractStatus(data?.contract_valid_until ?? null)
}

/** "December 1, 2026": a plain date, formatted as UTC to avoid a day shift. */
function readable(day: string): string {
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

/** Thrown at sign-in / refresh once access has closed. */
export function contractEndedError(s: ContractStatus): Error {
  return Object.assign(
    new Error(
      `Your company's contract with 8338 ended on ${readable(s.valid_until!)} and access closed on ${readable(s.access_until!)}. ` +
      'Contact 8338 to renew it; you can sign in again once the new contract date is entered.',
    ),
    { code: 'CONTRACT_ENDED' },
  )
}

/** The message a refused booking action carries while in grace (or later). */
export function contractBookingClosedMessage(s: ContractStatus): string {
  return `Your company's contract with 8338 ended on ${readable(s.valid_until!)}, so new bookings are closed. ` +
    'Contact 8338 to renew it. Your current deliveries carry on as normal.'
}
