import { pool } from '../../lib/database.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Chases the office about late drop-off confirmations still waiting for Accept
 * or Dismiss (late-confirmation.service). While one waits, that drop-off stays
 * undelivered, so the delivery can't finish and the client's confirmation and
 * the 3-day auto-complete never start. 15 minutes after it arrived, and every
 * 15 minutes after that, the Operations Manager and Company Administrator are
 * reminded, one notice per booking.
 *
 * Also closes flags that no longer need a decision: the drop-off was recorded
 * another way, or the booking is no longer on the road (cancelled).
 */

const MINUTE_MS = 60_000
const TICK_MS   = 5 * MINUTE_MS
export const LATE_REMIND_MS = 15 * MINUTE_MS

interface Row {
  late_id:          string
  booking_id:       string
  received_at:      string
  last_reminded_at: string | null
  stop_status:      string
  booking_status:   string
}

/** One pass. Exported so it can be driven from a script. */
export async function runLateConfirmationTick(now = Date.now()): Promise<{ reminded: number; closed: number }> {
  const { rows } = await pool.query<Row>(
    `SELECT lc.late_id, lc.booking_id, lc.received_at, lc.last_reminded_at,
            CASE WHEN lc.kind = 'pickup'
                 THEN CASE WHEN t.status = 'pending' THEN 'pending' ELSE t.status END
                 ELSE s.status END AS stop_status,
            b.status AS booking_status
       FROM late_confirmations lc
       JOIN booking_trips t ON t.trip_id = lc.trip_id
       LEFT JOIN booking_trip_stops s ON s.trip_stop_id = lc.trip_stop_id
       JOIN bookings b ON b.booking_id = lc.booking_id
      WHERE lc.status = 'pending'`)

  let closed = 0
  const due = new Map<string, Row[]>()
  for (const r of rows) {
    if (r.stop_status !== 'pending' || !['in_transit', 'delivered'].includes(r.booking_status)) {
      await pool.query(
        `UPDATE late_confirmations SET status = 'superseded', resolved_at = now(),
                resolution_note = $2 WHERE late_id = $1 AND status = 'pending'`,
        [r.late_id, r.stop_status !== 'pending'
          ? 'Recorded another way'
          : `The booking is no longer on the road (${r.booking_status})`])
      closed++
      continue
    }
    const last = new Date(r.last_reminded_at ?? r.received_at).getTime()
    if (now - last < LATE_REMIND_MS) continue
    due.set(r.booking_id, [...(due.get(r.booking_id) ?? []), r])
  }

  let reminded = 0
  for (const [bookingId, list] of due) {
    try {
      const booking = await BookingModel.findById(bookingId)
      if (!booking) continue
      const oldest  = Math.min(...list.map((r) => new Date(r.received_at).getTime()))
      await notifyStage('late_confirmation_unhandled', booking, { minutesLeft: Math.round((now - oldest) / MINUTE_MS) })
      await pool.query(
        `UPDATE late_confirmations SET last_reminded_at = now() WHERE late_id = ANY($1::uuid[])`,
        [list.map((r) => r.late_id)])
      reminded++
    } catch (err) {
      console.error('[late-confirmations] reminder failed for booking', bookingId, err)
      logSystemError('late-confirmation.scheduler', 'cron_job', err, { booking_id: bookingId })
    }
  }

  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'late-confirmation.scheduler',
    message:    `Late confirmation tick: ${reminded} reminder(s), ${closed} closed`,
    metadata:   { waiting: rows.length, reminded, closed },
  })
  return { reminded, closed }
}

let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runLateConfirmationTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[late-confirmations] tick failed', err)
      logSystemError('late-confirmation.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startLateConfirmationScheduler(): void {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 45_000).unref?.()
}
