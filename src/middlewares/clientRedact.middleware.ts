import { Request, Response, NextFunction } from 'express'

/**
 * Fields a client account never receives, whatever route or embed put them in
 * the reply. The booking queries are shared with staff (Booking Management shows
 * the driver's license number), so trimming them route by route would miss the
 * next embed; stripping on the way out covers list, detail, resolve, the replies
 * to create/update, and the @BK mention cards in one place.
 *
 * Industry practice (Lalamove, Grab, Onfleet): the customer sees the driver's
 * name, photo and plate, never their license. Found by a console test of a
 * client session, 2026-11-21.
 */
const CLIENT_HIDDEN_KEYS = new Set(['license_number'])

/**
 * A copy without the hidden keys. Never edits in place: a reply can hold an
 * object a cache shares with staff replies, which must keep the field.
 * Only plain objects and arrays are walked; Dates and the like pass as they are.
 */
function stripped(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripped)
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (!CLIENT_HIDDEN_KEYS.has(key)) out[key] = stripped(v)
  }
  return out
}

/** Mounted once before the routes; acts only when the signed-in caller is a client. */
export function clientRedact(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res)
  res.json = ((body: unknown) => {
    // req.user is set by authenticate() by the time the route answers.
    return json(req.user?.role === 'client' ? stripped(body) : body)
  }) as Response['json']
  next()
}
