import { Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase.js'

/**
 * Resolves the caller's own owning record — their `clients.client_id` or
 * `drivers.driver_id` — and pins it to the request.
 *
 * A route that takes an owner id from the URL and trusts it lets any
 * authenticated user read someone else's data by changing a uuid. Resolving the
 * id from the session instead means a caller can only ever address themselves,
 * and the path parameter becomes decoration rather than authorisation.
 *
 * Staff roles pass straight through with the id left null; their access is
 * governed by role and by the module tier.
 */

declare global {
  namespace Express {
    interface Request {
      clientId?: string | null
      driverId?: string | null
    }
  }
}

/** user_id -> owning row id. The mapping never changes for a given user. */
const clientCache = new Map<string, { id: string | null; at: number }>()
const driverCache = new Map<string, { id: string | null; at: number }>()
const TTL_MS = 60_000

export function invalidateClientScope(userId: string): void {
  clientCache.delete(userId)
}

export function invalidateDriverScope(userId: string): void {
  driverCache.delete(userId)
}

/** Shared resolver: look up the caller's own row id in `table`, with a TTL cache. */
async function resolveOwnId(
  userId: string,
  table: 'clients' | 'drivers',
  column: 'client_id' | 'driver_id',
  cache: Map<string, { id: string | null; at: number }>,
): Promise<string | null> {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.id

  const { data, error } = await supabase
    .from(table)
    .select(column)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  const id = (data as Record<string, string> | null)?.[column] ?? null
  cache.set(userId, { id, at: Date.now() })
  return id
}

export async function attachClientScope(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.user?.role !== 'client') {
    req.clientId = null
    return next()
  }

  try {
    const clientId = await resolveOwnId(req.user.sub, 'clients', 'client_id', clientCache)
    req.clientId = clientId

    if (!clientId) {
      // A client-role login with no client row cannot be billed and would
      // otherwise fall through to an unscoped query.
      res.status(403).json({
        status: 'error',
        message: 'This account is not linked to a client company.',
      })
      return
    }
    next()
  } catch (err) {
    console.error('[attachClientScope]', (err as Error).message)
    res.status(500).json({ status: 'error', message: 'Could not resolve your client account.' })
  }
}

/**
 * The driver equivalent.
 *
 * `/booking/driver/:driverId` and `/driver/:driverId/bookings` both took the id
 * straight from the URL, so one driver could read another's whole run sheet —
 * client company, origins, drop-offs, cargo and schedule. A driver is now
 * pinned to their own id; staff keep passing whatever the URL carries.
 *
 * Unlike the client case a missing driver row is NOT a 403: a driver with no
 * row simply has no bookings, and the service returns an empty list.
 */
export async function attachDriverScope(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.user?.role !== 'driver') {
    req.driverId = null
    return next()
  }

  try {
    req.driverId = await resolveOwnId(req.user.sub, 'drivers', 'driver_id', driverCache)
  } catch (err) {
    // Failing closed: an unresolved driver scopes to nothing rather than
    // falling through to whatever id the URL carried.
    console.error('[attachDriverScope]', (err as Error).message)
    req.driverId = null
  }
  next()
}
