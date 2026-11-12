import type { Response } from 'express'
import { pool } from '../../lib/database.js'
import { confirmedAtMs } from './late-confirmation.service.js'

/**
 * No new progress while the office has a delivery paused (user 2026-11-12).
 *
 * Only the Company Administrator and the Operations Manager pause and resume
 * (2026-10-24). Before this, a pause only silenced the driver's guidance: the
 * driver could keep confirming pickups and drop-offs while the client and the
 * office read the delivery as paused.
 *
 * A step DONE before the pause started but sent late (the phone had no signal)
 * is still accepted: the app sends `confirmed_at` (phone clock, corrected by
 * X-Device-Time), the same evidence late confirmations are judged by. A step
 * with no time (an older app) cannot prove that, so it waits for the resume.
 *
 * The refusal is a 403 with code BOOKING_PAUSED on purpose: every app version's
 * offline queue HOLDS a plain 403 and retries it (dropping one would lose a
 * delivery the driver confirmed), so a refused step goes through on its own
 * once the office ends the pause. Other refusals (409 after 5 tries, other 4xx)
 * are dropped by the queue, which a pause of several days would trigger.
 */
export interface PausedRefusal {
  paused_at: string
  reason:    string | null
}

type Ref = { bookingId: string } | { tripId: string } | { tripStopId: string }

export async function pausedRefusal(ref: Ref, confirmedAtRaw: string | null | undefined): Promise<PausedRefusal | null> {
  const { rows } = await pool.query<{ paused_at: string | null; pause_reason: string | null }>(
    'bookingId' in ref
      ? `SELECT b.paused_at, b.pause_reason FROM public.bookings b WHERE b.booking_id = $1`
      : 'tripId' in ref
        ? `SELECT b.paused_at, b.pause_reason FROM public.booking_trips t
             JOIN public.bookings b ON b.booking_id = t.booking_id WHERE t.trip_id = $1`
        : `SELECT b.paused_at, b.pause_reason FROM public.booking_trip_stops s
             JOIN public.booking_trips t ON t.trip_id = s.trip_id
             JOIN public.bookings b ON b.booking_id = t.booking_id WHERE s.trip_stop_id = $1`,
    ['bookingId' in ref ? ref.bookingId : 'tripId' in ref ? ref.tripId : ref.tripStopId],
  )
  const pausedAt = rows[0]?.paused_at
  if (!pausedAt) return null              // not paused (or not found: the service says so)

  const doneAt = confirmedAtMs(confirmedAtRaw ?? null)
  if (doneAt != null && doneAt < new Date(pausedAt).getTime()) return null  // done before the pause

  return { paused_at: new Date(pausedAt).toISOString(), reason: rows[0]?.pause_reason ?? null }
}

export function sendPausedRefusal(res: Response, refusal: PausedRefusal): void {
  res.status(403).json({
    status:    'error',
    code:      'BOOKING_PAUSED',
    message:   'This delivery is paused by the office. Ask them to end the pause; this step will be sent once they do.',
    paused_at: refusal.paused_at,
    reason:    refusal.reason,
  })
}
