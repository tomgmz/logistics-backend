import { BookingModel } from '../../models/client/booking.model.js'
import { AUTO_COMPLETE_DAYS, autoCompleteBookingService } from '../client/booking.service.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Closes delivered bookings the client never answered.
 *
 * The driver's last drop-off leaves a booking at 'delivered'; the client
 * confirms it or reports a problem. If they do neither, it completes on its own
 * AUTO_COMPLETE_DAYS after delivery — the day before, they get one reminder.
 * A reported problem takes the booking out of this queue entirely until staff
 * confirm it themselves.
 *
 * Same shape as the fleet re-check scheduler: an in-process tick, idempotent
 * through stamps on the booking (`completion_reminder_sent_at`, and the status
 * guard in markCompleted), so extra processes or restarts send nothing twice.
 */

const DAY_MS  = 24 * 60 * 60 * 1000
const TICK_MS = 15 * 60 * 1000

/** One pass. Exported so it can be driven from a script. */
export async function runCompletionTick(now = new Date()): Promise<{ reminded: number; completed: number }> {
  let reminded  = 0
  let completed = 0
  const rows = await BookingModel.findAwaitingCompletion()

  for (const row of rows) {
    if (!row.delivered_at) continue
    const age = now.getTime() - new Date(row.delivered_at).getTime()

    try {
      if (age >= AUTO_COMPLETE_DAYS * DAY_MS) {
        if (await autoCompleteBookingService(row.booking_id)) completed++
        continue
      }
      if (!row.completion_reminder_sent_at && age >= (AUTO_COMPLETE_DAYS - 1) * DAY_MS) {
        const booking = await BookingModel.findById(row.booking_id)
        if (!booking) continue
        await notifyStage('delivery_confirm_reminder', booking)
        // Stamped after the send, so a failed send is retried next tick.
        await BookingModel.markCompletionReminderSent(row.booking_id)
        reminded++
      }
    } catch (err) {
      console.error('[completion] failed for booking', row.booking_id, err)
      logSystemError('completion.scheduler', 'cron_job', err, { booking_id: row.booking_id })
    }
  }

  // Heartbeat on success too: a scheduler that silently stops means delivered
  // bookings quietly never complete.
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'completion.scheduler',
    message:    `Completion tick: ${completed} auto-completed, ${reminded} reminder(s) sent`,
    metadata:   { candidates: rows.length, completed, reminded },
  })

  return { reminded, completed }
}

let timer: NodeJS.Timeout | null = null

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startCompletionScheduler(): void {
  if (timer) return

  const tick = () => {
    runCompletionTick().catch((err) => {
      console.error('[completion] tick failed', err)
      logSystemError('completion.scheduler', 'cron_job', err)
    })
  }

  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  // Catch up at boot on anything that came due while the server was down.
  setTimeout(tick, 15_000).unref?.()
}
