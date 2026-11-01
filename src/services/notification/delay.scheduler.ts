import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Flags a delivery as DELAYED, the way a pause is flagged: a mark on the booking
 * (`bookings.delayed_since` …), never a status, so the trip, the queue and the
 * proof trail are untouched.
 *
 * Every tick, for each delivery in transit and not paused, it looks at the next
 * stop still owed a delivery (in the run order, the driver's chosen order
 * included):
 *
 *   planned  = that stop's planned arrival (planned-eta.service), shown to the
 *              client as a 30-minute window
 *   expected = the live ETA to it, when the truck reported recently; otherwise,
 *              only once the window has closed, "now" (it is at least that late)
 *
 *   late by ≥ SET_MIN past the window's end  → delayed
 *   back inside the window (late ≤ 0)         → cleared
 *   in between                                → stays as it was (no flapping)
 *
 * A truck that stops reporting is not called late while its window is still
 * open: no signal is not lateness. Once the window closes undelivered it is late
 * whatever the signal, and `delay_expected_at` is null (no new time to give).
 *
 * The client is told once when the delay starts and again only when it grows by
 * RENOTIFY_MIN; Operations + the Company Administrator are told when it starts.
 * `delay_max_minutes` stays after it clears, for on-time reporting.
 *
 * Same in-process shape as the other schedulers.
 */

const MINUTE_MS     = 60_000
const TICK_MS       = 5 * MINUTE_MS
const WINDOW_MS     = 30 * MINUTE_MS
const ROUND_MS      = 5 * MINUTE_MS
const SET_MIN       = 15
const RENOTIFY_MIN  = 30
const FRESH_FIX_MS  = 10 * MINUTE_MS
const FRESH_ETA_MS  = 15 * MINUTE_MS

interface BookingRow {
  booking_id:             string
  status:                 string
  paused_at:              string | null
  delayed_since:          string | null
  delay_minutes:          number | null
  delay_notified_minutes: number | null
  delay_max_minutes:      number | null
  breakdown_reported_at:  string | null
}

interface StopRow {
  destination_id:     string
  status:             string
  sequence_order:     number
  planned_arrival_at: string | null
}

interface TripRow {
  trip_number:        number
  status:             string
  booking_trip_stops: StopRow[]
}

/** End of the 30-minute window the client is shown for a planned arrival. */
function windowEnd(plannedIso: string): number {
  return Math.floor(Date.parse(plannedIso) / ROUND_MS) * ROUND_MS + WINDOW_MS
}

/** "4:35 – 5:05 PM" (or with the day when not today), Manila. */
function windowLabel(iso: string): string {
  const start = new Date(Math.floor(Date.parse(iso) / ROUND_MS) * ROUND_MS)
  const end   = new Date(start.getTime() + WINDOW_MS)
  const time  = (d: Date) => d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })
  const day   = (d: Date) => d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' })
  return day(start) === day(new Date()) ? `${time(start)} – ${time(end)}` : `${day(start)}, ${time(start)} – ${time(end)}`
}

/** The next stop still owed a delivery, in run order. */
function nextStop(trips: TripRow[]): StopRow | null {
  for (const t of [...trips].sort((a, b) => a.trip_number - b.trip_number)) {
    if (t.status === 'completed' || t.status === 'cancelled') continue
    const open = [...(t.booking_trip_stops ?? [])]
      .filter((s) => s.status !== 'delivered')
      .sort((a, b) => a.sequence_order - b.sequence_order)
    if (open.length) return open[0]
  }
  return null
}

async function liveEta(bookingId: string, destinationId: string, now: number): Promise<number | null> {
  const { data, error } = await supabase
    .from('driver_locations')
    .select('recorded_at, eta_computed_at, eta_stops')
    .eq('booking_id', bookingId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.recorded_at || !data.eta_computed_at) return null
  if (now - Date.parse(data.recorded_at) > FRESH_FIX_MS) return null
  if (now - Date.parse(data.eta_computed_at) > FRESH_ETA_MS) return null
  const hit = ((data.eta_stops ?? []) as Array<{ destination_id: string; eta_at: string }>)
    .find((e) => e.destination_id === destinationId)
  return hit ? Date.parse(hit.eta_at) : null
}

async function update(bookingId: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('bookings').update(fields).eq('booking_id', bookingId)
  if (error) throw error
}

const CLEAR = {
  delayed_since: null, delay_minutes: null, delay_expected_at: null,
  delay_destination_id: null, delay_notified_minutes: null,
}

/** One delivery. Returns what happened, for the heartbeat. */
async function evaluate(b: BookingRow, now: number): Promise<'set' | 'cleared' | 'renotified' | null> {
  // Ended, or paused (the pause explains itself): no delay flag stands.
  if (b.status !== 'in_transit' || b.paused_at) {
    if (b.delayed_since && b.status !== 'in_transit') { await update(b.booking_id, CLEAR); return 'cleared' }
    return null
  }

  // A breakdown the driver reported is waiting for the office: the client hears
  // the real reason from the pause, not a "running late" notice first.
  if (b.breakdown_reported_at) return null

  const { data: trips, error } = await supabase
    .from('booking_trips')
    .select('trip_number, status, booking_trip_stops ( destination_id, status, sequence_order, planned_arrival_at )')
    .eq('booking_id', b.booking_id)
  if (error) throw error

  const stop = nextStop((trips ?? []) as TripRow[])
  if (!stop?.planned_arrival_at) {
    if (b.delayed_since) { await update(b.booking_id, CLEAR); return 'cleared' }
    return null
  }

  const end      = windowEnd(stop.planned_arrival_at)
  const eta      = await liveEta(b.booking_id, stop.destination_id, now)
  const expected = eta ?? (now > end ? now : null)
  // No signal and the window is still open: nothing to conclude.
  if (expected == null) return null

  const lateMin = Math.round((expected - end) / MINUTE_MS)

  if (!b.delayed_since) {
    if (lateMin < SET_MIN) return null
    const nowIso = new Date(now).toISOString()
    await update(b.booking_id, {
      delayed_since:          nowIso,
      delay_minutes:          lateMin,
      delay_expected_at:      eta ? new Date(eta).toISOString() : null,
      delay_destination_id:   stop.destination_id,
      delay_notified_minutes: lateMin,
      delay_max_minutes:      Math.max(lateMin, b.delay_max_minutes ?? 0),
    })
    const booking = await BookingModel.findById(b.booking_id)
    if (booking) {
      const newArrival = eta ? windowLabel(new Date(eta).toISOString()) : undefined
      void notifyStage('delivery_delayed', booking, { minutesLeft: lateMin, newArrival })
      void notifyStage('delivery_delayed_staff', booking, { minutesLeft: lateMin, newArrival })
    }
    return 'set'
  }

  if (lateMin <= 0) { await update(b.booking_id, CLEAR); return 'cleared' }

  const notified = b.delay_notified_minutes ?? 0
  const renotify = lateMin >= notified + RENOTIFY_MIN
  await update(b.booking_id, {
    delay_minutes:        lateMin,
    delay_expected_at:    eta ? new Date(eta).toISOString() : null,
    delay_destination_id: stop.destination_id,
    delay_max_minutes:    Math.max(lateMin, b.delay_max_minutes ?? 0),
    ...(renotify ? { delay_notified_minutes: lateMin } : {}),
  })
  if (renotify) {
    const booking = await BookingModel.findById(b.booking_id)
    if (booking) {
      void notifyStage('delivery_delayed', booking, {
        minutesLeft: lateMin,
        newArrival:  eta ? windowLabel(new Date(eta).toISOString()) : undefined,
      })
    }
    return 'renotified'
  }
  return null
}

/** One pass. Exported so it can be driven from a script. */
export async function runDelayTick(now = Date.now()): Promise<Record<string, number>> {
  // In transit, plus any still flagged after it ended (to clear them).
  const { data, error } = await supabase
    .from('bookings')
    .select('booking_id, status, paused_at, delayed_since, delay_minutes, delay_notified_minutes, delay_max_minutes, breakdown_reported_at')
    .or('status.eq.in_transit,delayed_since.not.is.null')
  if (error) throw error

  const counts: Record<string, number> = { set: 0, cleared: 0, renotified: 0 }
  for (const b of (data ?? []) as BookingRow[]) {
    try {
      const r = await evaluate(b, now)
      if (r) counts[r]++
    } catch (err) {
      console.error('[delay] evaluation failed for booking', b.booking_id, err)
      logSystemError('delay.scheduler', 'cron_job', err, { booking_id: b.booking_id })
    }
  }

  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'delay.scheduler',
    message:    `Delay tick: ${counts.set} delayed, ${counts.cleared} cleared, ${counts.renotified} re-notified`,
    metadata:   { checked: (data ?? []).length, ...counts },
  })
  return counts
}

let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runDelayTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[delay] tick failed', err)
      logSystemError('delay.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startDelayScheduler(): void {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 25_000).unref?.()
}
