import { autoResolveQuietSince } from '../../models/admin/system-log-issues.model.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Closes system log issues that have gone quiet (Sentry's auto-resolve): an
 * open issue with no new occurrence for QUIET_DAYS is resolved as 'auto'. If it
 * happens again it reopens as a regression, so nothing is lost — the queue just
 * stops holding problems that already went away (a one-off provider outage).
 *
 * Same in-process shape as the IT Administrator handover scheduler.
 */

const TICK_MS    = 60 * 60 * 1000
export const QUIET_DAYS = 7

let timer: NodeJS.Timeout | null = null
let running = false

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const before = new Date(Date.now() - QUIET_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const closed = await autoResolveQuietSince(before)
    logSystem({
      log_level:  'info',
      event_type: 'cron_job',
      source:     'system-log-issues.scheduler',
      message:    `System log issue tick: ${closed} issue(s) quiet for ${QUIET_DAYS} days resolved`,
      metadata:   { closed, quiet_days: QUIET_DAYS },
    })
  } catch (err) {
    console.error('[system-log-issues] tick failed', err)
    logSystemError('system-log-issues.scheduler', 'cron_job', err)
  } finally {
    running = false
  }
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startSystemLogIssueScheduler(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref?.()
  setTimeout(() => { void tick() }, 35_000).unref?.()
}
