import { completeMissedHandovers } from './it-admin.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Safety net for the IT Administrator handover. A handover ends the moment the
 * successor sets their own password (completeHandoverOnConfirm); this hourly
 * tick finishes any that were confirmed but not closed. Nothing ends on a timer:
 * the 30-day render is a target, and without a confirmed successor the outgoing
 * IT Admin stays active.
 *
 * Same in-process shape as the license-expiry scheduler.
 */

const TICK_MS = 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let running = false

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const closed = await completeMissedHandovers()
    // Heartbeat on success too, so the IT Admin dashboard can tell a quiet hour
    // from a stopped scheduler.
    logSystem({
      log_level:  'info',
      event_type: 'cron_job',
      source:     'it-admin-render.scheduler',
      message:    `IT Administrator handover tick: ${closed} missed handover(s) completed`,
      metadata:   { closed },
    })
  } catch (err) {
    console.error('[it-admin-render] tick failed', err)
    logSystemError('it-admin-render.scheduler', 'cron_job', err)
  } finally {
    running = false
  }
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startItAdminRenderScheduler(): void {
  if (timer) return

  timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref?.()
  setTimeout(() => { void tick() }, 25_000).unref?.()
}
