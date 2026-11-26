import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { phDay } from '../../lib/ph-date.js'
import { callAt, formatClock, pickupLabel } from './driver-call.scheduler.js'

/**
 * Late start: a booking still Assigned 15 min after the driver call time
 * operations set in the Trip Planner (when the driver should start so the truck
 * is at the pickup point by the client's pick-up time). Never the client's own
 * time (user 2026-11-26): with no driver call time there is no Late start, and
 * the Delayed mark (delay.scheduler) covers the client's pick-up time itself.
 *
 * The office's early warning, before the client is affected. Industry: Onfleet
 * alerts the dispatcher when an assigned task hasn't started by its time;
 * Samsara tracks a route from before its scheduled start.
 *
 *   call time + 15 min, still Assigned → `late_start_for` set (the "Late start"
 *     mark), one more push to the drivers, a notice to the Operations Manager +
 *     Company Administrator
 *   every 30 min after that → the office again, until it starts, is cancelled,
 *     or gets a new call time; the repeats stop 24 h after the call time (the
 *     mark and the dashboard row stay)
 *   the client → never from here; the Delayed mark tells them once the pick-up
 *     time passes without the truck
 *
 * Cleared when the booking is no longer Assigned or its call time moved.
 */

const MINUTE_MS     = 60_000
const DAY_MS        = 24 * 60 * MINUTE_MS
const TICK_MS       = 5 * MINUTE_MS
const GRACE_MS      = 15 * MINUTE_MS
const REMIND_MS     = 30 * MINUTE_MS
const STOP_REMIND_MS = DAY_MS

const CLEAR = { late_start_for: null, late_start_reminded_at: null }

interface Row {
  booking_id:             string
  status:                 string
  schedule_date:          string
  call_time:              string | null
  driver_call_time:       string | null
  driver_call_date:       string | null
  late_start_for:         string | null
  late_start_reminded_at: string | null
  late_start_client_for:  string | null
}

const COLUMNS =
  'booking_id, status, schedule_date, call_time, driver_call_time, driver_call_date, ' +
  'late_start_for, late_start_reminded_at, late_start_client_for'

/** The instant the driver was due to start: the driver call time only. */
export function dueAt(r: Pick<Row, 'schedule_date' | 'driver_call_time' | 'driver_call_date'>): Date | null {
  return r.driver_call_time ? callAt(r.driver_call_date ?? r.schedule_date, r.driver_call_time) : null
}

/** Write only while the booking is still Assigned, so a start in between wins. */
async function updateIfAssigned(bookingId: string, fields: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await supabase
    .from('bookings').update(fields)
    .eq('booking_id', bookingId).eq('status', 'assigned')
    .select('booking_id')
  if (error) throw error
  return (data ?? []).length > 0
}

async function evaluate(r: Row, now: number): Promise<'set' | 'reminded' | 'cleared' | null> {
  const at   = r.status === 'assigned' ? dueAt(r) : null
  const late = at != null && now - at.getTime() >= GRACE_MS

  if (!late) {
    if (r.late_start_for) {
      const { error } = await supabase.from('bookings').update(CLEAR).eq('booking_id', r.booking_id)
      if (error) throw error
      return 'cleared'
    }
    return null
  }

  const callIso   = at!.toISOString()
  const flagged   = !!r.late_start_for && Date.parse(r.late_start_for) === at!.getTime()
  const minsLate  = Math.round((now - at!.getTime()) / MINUTE_MS)
  const extra     = { callTimeLabel: formatClock(at!), minutesLeft: minsLate, pickupTimeLabel: pickupLabel(r.schedule_date, r.call_time) }
  let result: 'set' | 'reminded' | null = null

  if (!flagged) {
    if (!(await updateIfAssigned(r.booking_id, { late_start_for: callIso, late_start_reminded_at: new Date(now).toISOString() }))) return null
    const booking = await BookingModel.findById(r.booking_id)
    if (booking) {
      await notifyStage('late_start_driver', booking, extra)
      await notifyStage('late_start_staff', booking, extra)
    }
    result = 'set'
  } else if (
    now - at!.getTime() < STOP_REMIND_MS &&
    now - Date.parse(r.late_start_reminded_at ?? r.late_start_for!) >= REMIND_MS
  ) {
    if (!(await updateIfAssigned(r.booking_id, { late_start_reminded_at: new Date(now).toISOString() }))) return null
    const booking = await BookingModel.findById(r.booking_id)
    if (booking) await notifyStage('late_start_staff', booking, { ...extra, repeat: true })
    result = 'reminded'
  }

  return result
}

/** One pass. Exported so it can be driven from a script. */
export async function runLateStartTick(now = Date.now()): Promise<Record<string, number>> {
  // Assigned around today (a driver call may be the day before the booking, and
  // a late one can run past midnight), plus any still flagged, to clear them.
  const [assigned, flagged] = await Promise.all([
    supabase.from('bookings').select(COLUMNS)
      .eq('status', 'assigned')
      .gte('schedule_date', phDay(now - 2 * DAY_MS))
      .lte('schedule_date', phDay(now + DAY_MS)),
    supabase.from('bookings').select(COLUMNS).not('late_start_for', 'is', null),
  ])
  if (assigned.error) throw assigned.error
  if (flagged.error)  throw flagged.error

  const rows = new Map<string, Row>()
  for (const r of [...(assigned.data ?? []), ...(flagged.data ?? [])] as unknown as Row[]) rows.set(r.booking_id, r)

  const counts: Record<string, number> = { set: 0, reminded: 0, cleared: 0 }
  for (const r of rows.values()) {
    try {
      const res = await evaluate(r, now)
      if (res) counts[res]++
    } catch (err) {
      console.error('[late-start] evaluation failed for booking', r.booking_id, err)
      logSystemError('late-start.scheduler', 'cron_job', err, { booking_id: r.booking_id })
    }
  }

  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'late-start.scheduler',
    message:    `Late start tick: ${counts.set} flagged, ${counts.reminded} reminded, ${counts.cleared} cleared`,
    metadata:   { checked: rows.size, ...counts },
  })
  return counts
}

let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runLateStartTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[late-start] tick failed', err)
      logSystemError('late-start.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startLateStartScheduler(): void {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 35_000).unref?.()
}
