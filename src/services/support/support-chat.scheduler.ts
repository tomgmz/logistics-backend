import { logSystem, logSystemError } from '../../lib/log-system.js'
import { autoResolveQuiet, emailMissedReplies } from './conversation.service.js'

/**
 * Client support conversations (2026-11-22), every 5 minutes:
 *   - email staff replies the client hasn't read in 15 minutes
 *   - resolve conversations the client left unanswered for 3 days
 * Shown on the IT Administrator dashboard as "Client chat emails and closing".
 */

const TICK_MS = 5 * 60_000

export async function runSupportChatTick(): Promise<{ emailed: number; resolved: number }> {
  const emailed  = await emailMissedReplies()
  const resolved = await autoResolveQuiet()
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'support-chat.scheduler',
    message:    `Client chats: ${emailed} missed replies emailed, ${resolved} quiet conversations closed`,
    metadata:   { emailed, resolved },
  })
  return { emailed, resolved }
}

let timer: NodeJS.Timeout | null = null
let running = false

function tick(): void {
  if (running) return
  running = true
  runSupportChatTick()
    .catch((err) => {
      console.error('[support-chat] tick failed', err)
      logSystemError('support-chat.scheduler', 'cron_job', err)
    })
    .finally(() => { running = false })
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startSupportChatScheduler(): void {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 50_000).unref?.()
}
