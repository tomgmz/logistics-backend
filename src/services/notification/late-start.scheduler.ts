import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { phDay } from '../../lib/ph-date.js'
import { callAt, formatClock } from './driver-call.scheduler.js'

/**
 * Late start: a booking still Assigned after its call time. The call time is
 * the driver call time operations set in the Trip Planner, or the client's call
 * time when none was set (the same instant the 1-hour reminder uses).
 *
 * The Delayed mark (delay.scheduler) only looks at deliveries already on the
 * road, so without this a driver who never starts (dead phone, overslept, truck
 * won't start) left nobody told. Industry: Onfleet counts an assigned task that
 * hasn't started as delayed once its time passes and alerts the dispatcher;
 * Samsara tracks a route from before its scheduled start.
 *
 *   call time + 15 min, still Assigned → `late_start_for` set (the "Late start"
 *     mark), one more push to the drivers, a notice to the Operations Manager +
 *     Company Administrator
 *   every 30 min after that → the office again, until it starts, is cancelled,
 *     or gets a new call time; the repeats stop 24 h after the call time (the
 *     mark and the dashboard row stay) so a forgotten booking doesn't page the
 *     office for days
 *   the client → told once ("running late"), only when starting now would put
 *     the first drop-off 15+ min past its planned window; a start a few minutes
 *     late that still makes the window is not the client's concern
 *
 * Cleared when the booking is no longer Assigned or its call time moved (a new
 * call time can only be set in the future, so it is not late).
 *
 * Same in-process shape as the other schedulers.
 */

const MINUTE_MS     = 60_000
const DAY_MS        = 24 * 60 * MINUTE_MS
const TICK_MS       = 5 * MINUTE_MS
const GRACE_MS      = 15 * MINUTE_MS
const REMIND_MS     = 30 * MINUTE_MS
const STOP_REMIND_MS = DAY_MS
const WINDOW_MS     = 30 * MINUTE_MS
const ROUND_MS      = 5 * MINUTE_MS
const CLIENT_LATE_MIN = 15

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

/** The instant the crew was due: the driver call, else the client's call time. */
export function dueAt(r: Pick<Row, 'schedule_date' | 'call_time' | 'driver_call_time' | 'driver_call_date'>): Date | null {
  return r.driver_call_time
    ? callAt(r.driver_call_date ?? r.schedule_date, r.driver_call_time)
    : callAt(r.schedule_date, r.call_time)
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

/**
 * Minutes past the first drop-off's window if the truck started loading now,
 * or null when there is no planned arrival to measure against. Planned arrivals
 * are chained from the client's call time (planned-eta.service), so the run
 * keeps its planned length and just starts later.
 */
async function firstDropoffLateMin(r: Row, now: number): Promise<number | null> {
  const clientStart = callAt(r.schedule_date, r.call_time)
  if (!clientStart) return null
  const { data, error } = await supabase
    .from('booking_trips')
    .select('trip_number, booking_trip_stops ( status, sequence_order, planned_arrival_at )')
    .eq('booking_id', r.booking_id)
    .order('trip_number', { ascending: true })
    .limit(1)
  if (error) throw error
  const stops = ((data?.[0]?.booking_trip_stops ?? []) as Array<{ status: string; sequence_order: number; planned_arrival_at: string | null }>)
    .filter((s) => s.status !== 'delivered' && s.planned_arrival_at)
    .sort((a, b) => a.sequence_order - b.sequence_order)
  const planned = stops[0]?.planned_arrival_at
  if (!planned) return null

  const p         = Date.parse(planned)
  const start     = clientStart.getTime()
  const projected = Math.max(now, start) + (p - start)
  const windowEnd = Math.floor(p / ROUND_MS) * ROUND_MS + WINDOW_MS
  return Math.round((projected - windowEnd) / MINUTE_MS)
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
  const extra     = { callTimeLabel: formatClock(at!), minutesLeft: minsLate }
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

  // The client, once per call instant, only when the first drop-off is at risk.
  const clientTold = !!r.late_start_client_for && Date.parse(r.late_start_client_for) === at!.getTime()
  if (!clientTold) {
    const lateMin = await firstDropoffLateMin(r, now)
    if (lateMin != null && lateMin >= CLIENT_LATE_MIN &&
        await updateIfAssigned(r.booking_id, { late_start_client_for: callIso })) {
      const booking = await BookingModel.findById(r.booking_id)
      if (booking) await notifyStage('delivery_delayed', booking, { minutesLeft: lateMin })
    }
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
