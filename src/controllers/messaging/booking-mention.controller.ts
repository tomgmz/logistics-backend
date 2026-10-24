import type { Request, Response, NextFunction } from 'express'
import { searchMentionable, findMentionDetails, type MentionViewer } from '../../models/messaging/booking-mention.model.js'

/** A full booking number, e.g. BK-202610-00033. */
const BOOKING_REF = /^BK-\d{6}-\d{5,}$/
const MAX_REFS    = 20

function viewerOf(req: Request): MentionViewer {
  return {
    userId:   String(req.user?.sub ?? ''),
    role:     String(req.user?.role ?? ''),
    clientId: req.clientId ?? null,
    driverId: req.driverId ?? null,
  }
}

/** GET /messaging/booking-mentions?q= — the list shown after typing "@". */
export async function searchBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 40) : ''
    res.json({ success: true, data: await searchMentionable(viewerOf(req), q) })
  } catch (err) { next(err) }
}

/** GET /messaging/booking-mentions/details?refs=BK-…,BK-… — the cards under a message. */
export async function getDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw  = typeof req.query.refs === 'string' ? req.query.refs : ''
    const refs = [...new Set(raw.split(',').map(r => r.trim().toUpperCase()).filter(r => BOOKING_REF.test(r)))].slice(0, MAX_REFS)
    res.json({ success: true, data: await findMentionDetails(viewerOf(req), refs) })
  } catch (err) { next(err) }
}
