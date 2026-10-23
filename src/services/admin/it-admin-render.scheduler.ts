import { deactivateEndedRenders } from './it-admin.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Ends the 30-day render period of an IT Admin who handed the role over:
 * once users.render_ends_at has passed, the account is deactivated, signed out
 * everywhere and its login locked.
 *
 * Hourly, so an account closes within the hour after its period ends. The
 * successor is already the seat holder, so nothing waits on this.
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
    const closed = await deactivateEndedRenders()
    // Heartbeat on success too, so the IT Admin dashboard can tell a quiet hour
    // from a stopped scheduler.
    logSystem({
      log_level:  'info',
      event_type: 'cron_job',
      source:     'it-admin-render.scheduler',
      message:    `IT Administrator render tick: ${closed} account(s) deactivated`,
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
