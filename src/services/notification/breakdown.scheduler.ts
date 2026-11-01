import { pool } from '../../lib/database.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { clearBreakdown } from '../client/breakdown.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Chases the office about a breakdown the driver reported (breakdown.service):
 * 15 minutes after the report, and every 15 minutes after that, the Operations
 * Manager and Company Administrator are reminded until someone pauses the
 * delivery or confirms the truck is moving again. A flag left on a delivery
 * that was paused, or is no longer in transit, is cleared here.
 *
 * Same in-process shape as the other schedulers.
 */

const MINUTE_MS   = 60_000
const TICK_MS     = 5 * MINUTE_MS
const REMIND_MS   = 15 * MINUTE_MS

interface Row {
  booking_id:            string
  status:                string
  paused_at:             string | null
  breakdown_reported_at: string
  breakdown_reminded_at: string | null
}

/** One pass. Exported so it can be driven from a script. */
export async function runBreakdownTick(now = Date.now()): Promise<{ reminded: number; cleared: number }> {
  const { rows } = await pool.query<Row>(
    `SELECT booking_id, status, paused_at, breakdown_reported_at, breakdown_reminded_at
       FROM bookings WHERE breakdown_reported_at IS NOT NULL`)

  let reminded = 0
  let cleared  = 0
  for (const r of rows) {
    try {
      if (r.status !== 'in_transit' || r.paused_at) {
        await clearBreakdown(r.booking_id)
        cleared++
        continue
      }
      const last = new Date(r.breakdown_reminded_at ?? r.breakdown_reported_at).getTime()
      if (now - last < REMIND_MS) continue

      const booking = await BookingModel.findById(r.booking_id)
      if (!booking) continue
      const minutes = Math.round((now - new Date(r.breakdown_reported_at).getTime()) / MINUTE_MS)
      await notifyStage('breakdown_unhandled', booking, { minutesLeft: minutes })
      await pool.query(`UPDATE bookings SET breakdown_reminded_at = now() WHERE booking_id = $1`, [r.booking_id])
      reminded++
    } catch (err) {
      console.error('[breakdown] reminder failed for booking', r.booking_id, err)
      logSystemError('breakdown.scheduler', 'cron_job', err, { booking_id: r.booking_id })
    }
  }

  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'breakdown.scheduler',
    message:    `Breakdown tick: ${reminded} reminder(s), ${cleared} cleared`,
    metadata:   { waiting: rows.length, reminded, cleared },
  })
  return { reminded, cleared }
}

let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runBreakdownTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[breakdown] tick failed', err)
      logSystemError('breakdown.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startBreakdownScheduler(): void {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 30_000).unref?.()
}
