import { supabase } from './supabase.js'

/**
 * The IT Administrator stand-in (user's rule, 2026-11-06).
 *
 * When the IT Administrator resigns and no successor has confirmed within the
 * 30-day render, the Company Administrator named on the handover takes over
 * every IT Administrator power until the new IT Administrator sets their own
 * password. Their role stays 'admin' (they keep all their own work); the
 * server ALSO treats them as 'it_admin' (see authenticate → req.user.it_standin,
 * authorize, moduleGuard, password resets).
 *
 * "Active" means: an open handover (not ended, not cancelled) whose stand-in
 * has been activated by the render scheduler. Read on every authenticated
 * request, so it is cached briefly; every change calls invalidateStandinCache().
 * Worst case after a change on another server instance: CACHE_MS of staleness.
 */

const CACHE_MS = 30_000

let cached: { id: string | null; at: number } | null = null

export function invalidateStandinCache(): void {
  cached = null
}

/** The user id of the stand-in currently holding the IT Administrator powers, or null. */
export async function getActiveStandinId(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.id
  const { data, error } = await supabase
    .from('it_admin_handovers')
    .select('standin_id')
    .is('ended_at', null)
    .is('cancelled_at', null)
    .not('standin_activated_at', 'is', null)
    .not('standin_id', 'is', null)
    .maybeSingle()
  if (error) {
    // Fail closed (no stand-in powers), but don't cache the failure.
    console.error('[it-standin] lookup failed', error.message)
    return null
  }
  cached = { id: (data?.standin_id as string | undefined) ?? null, at: Date.now() }
  return cached.id
}

/** Whether this signed-in user is the active stand-in. Only a Company Administrator can be. */
export async function isActiveStandin(userId: string, role: string): Promise<boolean> {
  if (role !== 'admin') return false
  return (await getActiveStandinId()) === userId
}
