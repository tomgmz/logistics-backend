import { supabase } from './supabase.js'
import { conflict } from './http-error.js'

export const PHONE_TAKEN_MESSAGE = 'This mobile number is already used by another account.'

/**
 * One mobile number, one account, across every role (2026-10-24).
 *
 * `users_phone_key` (unique on users.phone) is the guarantee; this check runs first so the common
 * case is a clear refusal BEFORE a Supabase Auth identity is created, rather
 * than an Auth user made and rolled back on the unique violation. Archived
 * accounts count: a deleted account keeps its number.
 *
 * `exceptUserId` is the account being edited, which may keep its own number.
 */
export async function assertPhoneAvailable(
  phone: string | null | undefined,
  exceptUserId?: string | null,
): Promise<void> {
  const value = phone?.trim()
  if (!value) return

  let query = supabase
    .from('users')
    .select('user_id', { count: 'exact', head: true })
    .eq('phone', value)
  if (exceptUserId) query = query.neq('user_id', exceptUserId)

  const { count, error } = await query
  if (error) throw error
  if ((count ?? 0) > 0) throw conflict(PHONE_TAKEN_MESSAGE)
}
