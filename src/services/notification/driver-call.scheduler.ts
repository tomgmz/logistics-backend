import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Reminds the crew of an assigned booking one hour before the driver's call time,
 * in the mobile app (row + realtime + push).
 *
 * The call time is the one operations set in the Trip Planner
 * (`bookings.driver_call_time`), or the client's `call_time` when operations set
 * none. It is a time to be at the pickup point, not a gate: the driver may start
 * earlier, and a booking already started (in transit) is not reminded at all.
 *
 * Once per call instant: `driver_call_reminder_for` holds the instant the
 * reminder went out for, written only after the fan-out resolves. Moving the
 * call time stops it matching, so the new time gets its own reminder. A call
 * time set less than an hour ahead is reminded on the next tick, with the
 * minutes actually left; one already past is left alone.
 *
 * Same in-process shape as the fleet re-check and license expiry schedulers.
 */

const PH_OFFSET = '+08:00'

const MINUTE_MS = 60 * 1000
const LEAD_MS   = 60 * MINUTE_MS
const DAY_MS    = 24 * 60 * MINUTE_MS
const TICK_MS   = 5 * MINUTE_MS

interface CandidateRow {
  booking_id:               string
  schedule_date:            string
  call_time:                string | null
  driver_call_time:         string | null
  driver_call_reminder_for: string | null
}

/** schedule_date + an `HH:MM[:SS]` time, PH time, as a UTC instant. */
function callAt(scheduleDate: string, time: string | null): Date | null {
  const day = String(scheduleDate ?? '').slice(0, 10)
  const hm  = String(time ?? '').slice(0, 8).replace(/^(\d{2}:\d{2})$/, '$1:00')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}$/.test(hm)) return null
  const at = new Date(`${day}T${hm}${PH_OFFSET}`)
  return Number.isNaN(at.getTime()) ? null : at
}

/** "9:05 AM", PH time. */
function formatClock(at: Date): string {
  return new Intl.DateTimeFormat('en-PH', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  }).format(at)
}

/** Assigned bookings around today — a narrow window keeps the tick cheap. */
async function findCandidates(now: Date): Promise<CandidateRow[]> {
  const dateOnly = (d: Date) => d.toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .select('booking_id, schedule_date, call_time, driver_call_time, driver_call_reminder_for')
    .eq('status', 'assigned')
    .gte('schedule_date', dateOnly(new Date(now.getTime() - DAY_MS)))
    .lte('schedule_date', dateOnly(new Date(now.getTime() + DAY_MS)))

  if (error) throw error
  return (data ?? []) as CandidateRow[]
}

/** One pass. Exported so it can be driven from a script. */
export async function runDriverCallTick(now = new Date()): Promise<number> {
  const rows = await findCandidates(now)
  let sent = 0

  for (const row of rows) {
    const at = callAt(row.schedule_date, row.driver_call_time ?? row.call_time)
    if (!at) continue

    const left = at.getTime() - now.getTime()
    if (left <= 0 || left > LEAD_MS) continue
    if (row.driver_call_reminder_for && Date.parse(row.driver_call_reminder_for) === at.getTime()) continue

    try {
      const booking = await BookingModel.findById(row.booking_id)
      if (!booking || booking.status !== 'assigned') continue

      await notifyStage('driver_call_reminder', booking, {
        callTimeLabel: formatClock(at),
        minutesLeft:   Math.max(1, Math.round(left / MINUTE_MS)),
      })
      await BookingModel.markDriverCallReminded(row.booking_id, at)
      sent++
    } catch (err) {
      console.error('[driver-call] reminder failed for booking', row.booking_id, err)
      logSystemError('driver-call.scheduler', 'cron_job', err, { booking_id: row.booking_id })
    }
  }

  // Heartbeat on success too, so the IT Admin dashboard can tell a quiet hour
  // from a stopped scheduler.
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'driver-call.scheduler',
    message:    `Driver call time tick: ${sent} reminder(s) sent`,
    metadata:   { candidates: rows.length, sent },
  })

  return sent
}

let timer: NodeJS.Timeout | null = null

// One pass at a time, so two overlapping passes never both read an unstamped
// booking and both send. A pass asked for while one runs becomes one follow-up.
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runDriverCallTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[driver-call] tick failed', err)
      logSystemError('driver-call.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/**
 * Check now instead of on the next tick — called after operations sets a call
 * time, so one set inside the hour is reminded straight away. Never throws.
 */
export function requestDriverCallCheck(): void {
  tick()
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startDriverCallScheduler(): void {
  if (timer) return

  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 15_000).unref?.()
}
