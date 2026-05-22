import { supabase } from './supabase.js'

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
  return false
}

export default deleteAuthUserSafely
