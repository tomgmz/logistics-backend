import { supabase } from './supabase.js'
import { logSystem } from './log-system.js'

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Delete a Supabase Auth user, retrying transient failures. Used to roll back
 * the auth identity when the matching DB profile could not be created.
 *
 * With the public.users -> auth.users ON DELETE CASCADE foreign key in place,
 * a successful deletion here also removes the profile row (and its
 * clients/drivers detail) if one somehow exists. Returns false only
 * when every attempt fails, in which case a durable audit record is written so
 * the orphaned auth identity can be reconciled later.
 */
export async function deleteAuthUserSafely(userId: string, attempts = 3, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      const { error } = await supabase.auth.admin.deleteUser(userId)
      if (!error) {
        console.log(`Auth rollback successful for user ${userId}`)
        return true
      }
      console.error(`Auth rollback attempt ${i + 1} failed for ${userId}:`, error.message)
    } catch (err: unknown) {
      console.error(`Auth rollback attempt ${i + 1} threw for ${userId}:`, err)
    }
    if (i < attempts - 1) await sleep(delayMs)
  }

  // Every attempt failed: the auth identity is now orphaned (no profile row).
  // Record it durably so it can be found and cleaned up out of band.
  // Was an audit row, but no person did this: it is the software failing to
  // clean up after itself, and the only useful reader is whoever fixes it.
  logSystem({
    log_level:  'error',
    event_type: 'db_event',
    source:     'auth-helpers.deleteAuthUserSafely',
    message:    `Failed to delete orphaned Supabase Auth user after ${attempts} attempts`,
    metadata:   { orphaned_auth_user: userId, attempts },
  })
  return false
}

export default deleteAuthUserSafely
