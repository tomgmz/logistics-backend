import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { continuationAt } from '../maps/planned-eta.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Watches paused deliveries that have a continuation date (the office set the
 * day and driver call time it moves again — see setPauseContinuationService):
 *
 *   * an hour before that call time, the crew is reminded (a typhoon pause can
 *     last days; nobody should have to remember the date from the first notice);
 *   * once the call time is OVERDUE_MS past and the delivery is still paused,
 *     the Operations Manager and Company Administrator are told to resume it or
 *     set a new date, so a stale date never sits on the client's screen.
 *
 * Once per continuation instant: `continuation_reminded_for` /
 * `continuation_overdue_for` hold the instant each notice went out for, written
 * after the fan-out resolves. Changing the date or call time stops them
 * matching, so the new time gets its own notices.
 *
 * Same in-process shape as driver-call.scheduler.ts.
 */

const MINUTE_MS  = 60 * 1000
const LEAD_MS    = 60 * MINUTE_MS
const OVERDUE_MS = 15 * MINUTE_MS
const TICK_MS    = 5 * MINUTE_MS

interface OpenPauseRow {
  pause_id:                  string
  booking_id:                string
  expected_resume_date:      string
  expected_resume_call_time: string
  continuation_reminded_for: string | null
  continuation_overdue_for:  string | null
}

/** "9:05 AM", PH time. */
function formatClock(at: number): string {
  return new Intl.DateTimeFormat('en-PH', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  }).format(new Date(at))
}

/** "Nov 5, 2026", PH time. */
function formatDay(at: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila',
  }).format(new Date(at))
}

const sameInstant = (stamp: string | null, at: number) => !!stamp && Date.parse(stamp) === at

/** Open pauses with a continuation set — a handful at most. */
async function findOpenPauses(): Promise<OpenPauseRow[]> {
  const { data, error } = await supabase
    .from('booking_pauses')
    .select('pause_id, booking_id, expected_resume_date, expected_resume_call_time, continuation_reminded_for, continuation_overdue_for')
    .is('resumed_at', null)
    .not('expected_resume_date', 'is', null)
    .not('expected_resume_call_time', 'is', null)
  if (error) throw error
  return (data ?? []) as OpenPauseRow[]
}

async function stamp(pauseId: string, field: 'continuation_reminded_for' | 'continuation_overdue_for', at: number): Promise<void> {
  const { error } = await supabase
    .from('booking_pauses')
    .update({ [field]: new Date(at).toISOString() })
    .eq('pause_id', pauseId)
  if (error) throw error
}

/** One pass. Exported so it can be driven from a script. */
export async function runPauseContinuationTick(now = Date.now()): Promise<{ reminded: number; overdue: number }> {
  const rows = await findOpenPauses()
  let reminded = 0
  let overdue  = 0

  for (const row of rows) {
    const at = continuationAt(row.expected_resume_date, row.expected_resume_call_time)
    if (at == null) continue
    const left = at - now

    const remind = left > 0 && left <= LEAD_MS && !sameInstant(row.continuation_reminded_for, at)
    const late   = -left >= OVERDUE_MS && !sameInstant(row.continuation_overdue_for, at)
    if (!remind && !late) continue

    try {
      const booking = await BookingModel.findById(row.booking_id)
      // Resumed (or ended) since the read: nothing to say.
      if (!booking || !(booking as { paused_at?: string | null }).paused_at) continue

      if (remind) {
        await notifyStage('pause_continuation_due', booking, {
          callTimeLabel: formatClock(at),
          minutesLeft:   Math.max(1, Math.round(left / MINUTE_MS)),
        })
        await stamp(row.pause_id, 'continuation_reminded_for', at)
        reminded++
      }
      if (late) {
        await notifyStage('pause_continuation_overdue', booking, {
          callTimeLabel:    formatClock(at),
          continuationDate: formatDay(at),
        })
        await stamp(row.pause_id, 'continuation_overdue_for', at)
        overdue++
      }
    } catch (err) {
      console.error('[pause-continuation] notice failed for booking', row.booking_id, err)
      logSystemError('pause-continuation.scheduler', 'cron_job', err, { booking_id: row.booking_id })
    }
  }

  // Heartbeat on success too, so the IT Admin dashboard can tell a quiet hour
  // from a stopped scheduler.
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'pause-continuation.scheduler',
    message:    `Pause continuation tick: ${reminded} reminder(s), ${overdue} overdue notice(s)`,
    metadata:   { open_pauses: rows.length, reminded, overdue },
  })

  return { reminded, overdue }
}

let timer: NodeJS.Timeout | null = null

// One pass at a time, so two overlapping passes never both send.
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runPauseContinuationTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[pause-continuation] tick failed', err)
      logSystemError('pause-continuation.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/** Check now instead of on the next tick — after the office sets a continuation. Never throws. */
export function requestPauseContinuationCheck(): void {
  if (!timer) return
  tick()
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startPauseContinuationScheduler(): void {
  if (timer) return

  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 20_000).unref?.()
}
