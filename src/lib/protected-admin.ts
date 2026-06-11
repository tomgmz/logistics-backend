import { supabase } from './supabase.js'

// The "root" administrator (earliest-created admin account) can never be
// restricted by module permissions — this guarantees there is always at least
// one unrestrictable admin who can manage the system and undo a bad config.
let cached: { id: string | null; expires: number } | null = null
const TTL_MS = 5 * 60 * 1000

export async function getRootAdminId(): Promise<string | null> {
  if (cached && cached.expires > Date.now()) return cached.id

  const { data, error } = await supabase
    .from('users')
    .select('user_id')
    .eq('role', 'admin')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    // Fail closed for availability (don't block requests) but don't cache.
    console.error('[protected-admin] root admin lookup failed:', error.message)
    return cached?.id ?? null
  }

  cached = { id: data?.user_id ?? null, expires: Date.now() + TTL_MS }
  return cached.id
}

export async function isProtectedAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false
  return userId === (await getRootAdminId())
}

export function invalidateRootAdminCache(): void {
  cached = null
}
