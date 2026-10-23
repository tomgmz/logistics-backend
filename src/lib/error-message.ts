import { PHONE_TAKEN_MESSAGE } from './phone-unique.js'

/**
 * A readable message from anything thrown.
 *
 * Supabase/PostgREST errors are plain objects ({ code, message, details }), not
 * Error instances, so `String(err)` turned them into "[object Object]" — which
 * is what a client saw when account creation hit a duplicate phone. The phone
 * unique index (`users_phone_key`) is mapped to the same wording the pre-check
 * uses.
 */
export function errorMessage(err: unknown): string {
  const e = err as { code?: string; message?: unknown; details?: unknown } | null
  const text = typeof e?.message === 'string' ? e.message : null

  if (e?.code === '23505' && `${text ?? ''} ${e.details ?? ''}`.includes('users_phone_key')) {
    return PHONE_TAKEN_MESSAGE
  }
  if (text) return text
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}
