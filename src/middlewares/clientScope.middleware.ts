import { Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase.js'

/**
 * Resolves the caller's own `clients.client_id` and pins it to the request.
 *
 * Billing routes must never take a client id from the caller. Elsewhere in this
 * codebase a client's own data is fetched through a `:clientId` path parameter,
 * which is fine for a booking list but not for invoices and payment records —
 * it would let any authenticated client read another company's figures by
 * changing a uuid in the URL. Resolving it from the session instead means a
 * client can only ever address themselves.
 *
 * Staff roles pass straight through with `clientId` left null; their access is
 * governed by the billing-management module tier.
 */

declare global {
  namespace Express {
    interface Request {
      clientId?: string | null
    }
  }
}

/** user_id -> client_id. The mapping never changes for a given user. */
const cache = new Map<string, { clientId: string | null; at: number }>()
const TTL_MS = 60_000

export function invalidateClientScope(userId: string): void {
  cache.delete(userId)
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

  const userId = req.user.sub
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) {
    req.clientId = hit.clientId
    return next()
  }

  try {
    const { data, error } = await supabase
      .from('clients')
      .select('client_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    const clientId = data?.client_id ?? null
    cache.set(userId, { clientId, at: Date.now() })
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
