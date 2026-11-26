import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { phDay } from '../../lib/ph-date.js'
import { callAt, formatClock } from './driver-call.scheduler.js'

/**
 * DELAYED = the truck is not at the pick-up point by the client's pick-up time
 * (user 2026-11-26: booking day + the client's call time, 0 minutes grace).
 * A mark on the booking (`bookings.delayed_since` …), like a pause, never a
 * status. Drop-offs have the live ETA only; being later than an estimate there
 * is not a delay (the planned arrival per drop-off was removed the same day).
 *
 * Industry: on-time pick-up against the pick-up appointment is the standard
 * carrier measure (SAP TM / Oracle TM appointment adherence, the OTP figure
 * shippers score carriers on); Onfleet marks a task delayed once its time
 * passes without it being done.
 *
 * Every tick, for each booking due for pick-up and not yet arrived there:
 *
 *   arrived = trip 1's arrival step at the pick-up (the phone), its loading
 *             proof, or a fresh GPS fix within ARRIVE_M of the pick-up point;
 *             stamped once into `pickup_arrived_at`, which ends the check and
 *             clears the mark
 *   due     = the client's pick-up time
 *   now ≥ due and not arrived → Delayed, minutes = how late it is (or will
 *             be, by the live ETA to the pick-up point when the truck reports)
 *
 * Approved bookings with no truck yet count too: the client's truck is late
 * whoever's fault it is. Paused deliveries and a breakdown waiting for the
 * office are left alone (they explain themselves). Later trips of a multi-trip
 * booking have no client time, so only trip 1's pick-up is measured.
 *
 * The client is told when it is set and again every RENOTIFY_MIN later;
 * Operations + the Company Administrator when it is set. `delay_max_minutes`
 * stays after it clears, for on-time reporting.
 */

const MINUTE_MS     = 60_000
const DAY_MS        = 24 * 60 * MINUTE_MS
const TICK_MS       = 5 * MINUTE_MS
const RENOTIFY_MIN  = 30
const FRESH_FIX_MS  = 10 * MINUTE_MS
const FRESH_ETA_MS  = 15 * MINUTE_MS
/** Same radius that gates the driver's confirm button. */
const ARRIVE_M      = 100

const DUE_STATUSES = ['approved', 'assigned', 'in_transit']

interface BookingRow {
  booking_id:             string
  status:                 string
  schedule_date:          string
  call_time:              string | null
  origin_latitude:        number | string | null
  origin_longitude:       number | string | null
  paused_at:              string | null
  pickup_arrived_at:      string | null
  delayed_since:          string | null
  delay_minutes:          number | null
  delay_notified_minutes: number | null
  delay_max_minutes:      number | null
  breakdown_reported_at:  string | null
}

const COLUMNS =
  'booking_id, status, schedule_date, call_time, origin_latitude, origin_longitude, paused_at, ' +
  'pickup_arrived_at, delayed_since, delay_minutes, delay_notified_minutes, delay_max_minutes, breakdown_reported_at'

const CLEAR = {
  delayed_since: null, delay_minutes: null, delay_expected_at: null,
  delay_destination_id: null, delay_notified_minutes: null,
}

async function update(bookingId: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('bookings').update(fields).eq('booking_id', bookingId)
  if (error) throw error
}

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLng = rad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

interface Position { recorded_at: string; latitude: number | string; longitude: number | string; accuracy_m: number | string | null; eta_pickup_at: string | null; eta_computed_at: string | null }

/** The latest position reported for the booking (the navigating phone). */
async function latestPosition(bookingId: string): Promise<Position | null> {
  const { data, error } = await supabase
    .from('driver_locations')
    .select('recorded_at, latitude, longitude, accuracy_m, eta_pickup_at, eta_computed_at')
    .eq('booking_id', bookingId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as Position | null) ?? null
}

/**
 * When the truck first reached the pick-up point for trip 1, or null. The
 * phone's arrival step and the loading proof are records; a GPS fix counts when
 * it is fresh and within ARRIVE_M (the phone may not have marked arrival yet
 * while the truck waits at the gate).
 */
async function pickupArrival(b: BookingRow, pos: Position | null, now: number): Promise<string | null> {
  const { data: trips, error } = await supabase
    .from('booking_trips')
    .select('trip_id, trip_number, status, pickup_proof_at')
    .eq('booking_id', b.booking_id)
    .neq('status', 'cancelled')
    .order('trip_number', { ascending: true })
    .limit(1)
  if (error) throw error
  const first = trips?.[0] as { trip_id: string; pickup_proof_at: string | null } | undefined

  const found: number[] = []
  if (first) {
    if (first.pickup_proof_at) found.push(Date.parse(first.pickup_proof_at))
    const { data: steps, error: stepError } = await supabase
      .from('stop_milestones')
      .select('at')
      .eq('trip_id', first.trip_id)
      .is('trip_stop_id', null)
      .in('stage', ['arrived', 'started'])
      .order('at', { ascending: true })
      .limit(1)
    if (stepError) throw stepError
    if (steps?.[0]?.at) found.push(Date.parse(steps[0].at))
  }

  const lat = Number(b.origin_latitude)
  const lng = Number(b.origin_longitude)
  if (pos && b.status === 'in_transit' && b.origin_latitude != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    const fresh = now - Date.parse(pos.recorded_at) <= FRESH_FIX_MS
    const acc   = pos.accuracy_m == null ? 0 : Number(pos.accuracy_m)
    if (fresh && acc <= ARRIVE_M && metres(Number(pos.latitude), Number(pos.longitude), lat, lng) <= ARRIVE_M) {
      found.push(Date.parse(pos.recorded_at))
    }
  }

  const at = found.filter(Number.isFinite).sort((x, y) => x - y)[0]
  return at != null ? new Date(at).toISOString() : null
}

/** The live ETA to the pick-up point, when the truck reported recently. */
function pickupEta(pos: Position | null, now: number): number | null {
  if (!pos?.eta_pickup_at || !pos.eta_computed_at) return null
  if (now - Date.parse(pos.recorded_at) > FRESH_FIX_MS) return null
  if (now - Date.parse(pos.eta_computed_at) > FRESH_ETA_MS) return null
  const at = Date.parse(pos.eta_pickup_at)
  return Number.isFinite(at) ? at : null
}

/** One booking. Returns what happened, for the heartbeat. */
async function evaluate(b: BookingRow, now: number): Promise<'set' | 'cleared' | 'renotified' | 'arrived' | null> {
  // Ended, or already at the pick-up: no delay mark stands.
  if (!DUE_STATUSES.includes(b.status) || b.pickup_arrived_at) {
    if (b.delayed_since) { await update(b.booking_id, CLEAR); return 'cleared' }
    return null
  }

  const pos     = b.status === 'in_transit' ? await latestPosition(b.booking_id) : null
  const arrived = b.status === 'approved' ? null : await pickupArrival(b, pos, now)
  if (arrived) {
    await update(b.booking_id, { pickup_arrived_at: arrived, ...(b.delayed_since ? CLEAR : {}) })
    return 'arrived'
  }

  // Paused, or a breakdown waiting for the office: the client hears the real
  // reason from the pause, not a "running late" notice.
  if (b.paused_at || b.breakdown_reported_at) return null

  const due = callAt(b.schedule_date, b.call_time)
  if (!due || now < due.getTime()) {
    // The pick-up time moved later: no longer late.
    if (b.delayed_since) { await update(b.booking_id, CLEAR); return 'cleared' }
    return null
  }

  const eta     = pickupEta(pos, now)
  const lateMin = Math.max(0, Math.round((Math.max(now, eta ?? now) - due.getTime()) / MINUTE_MS))
  const extra   = {
    minutesLeft:   lateMin,
    callTimeLabel: formatClock(due),
    newArrival:    eta ? formatClock(new Date(eta)) : undefined,
  }
  const fields = {
    delay_minutes:        lateMin,
    delay_expected_at:    eta ? new Date(eta).toISOString() : null,
    delay_destination_id: null,
    delay_max_minutes:    Math.max(lateMin, b.delay_max_minutes ?? 0),
  }

  if (!b.delayed_since) {
    await update(b.booking_id, { ...fields, delayed_since: new Date(now).toISOString(), delay_notified_minutes: lateMin })
    const booking = await BookingModel.findById(b.booking_id)
    if (booking) {
      void notifyStage('delivery_delayed', booking, extra)
      void notifyStage('delivery_delayed_staff', booking, extra)
    }
    return 'set'
  }

  const renotify = lateMin >= (b.delay_notified_minutes ?? 0) + RENOTIFY_MIN
  await update(b.booking_id, { ...fields, ...(renotify ? { delay_notified_minutes: lateMin } : {}) })
  if (renotify) {
    const booking = await BookingModel.findById(b.booking_id)
    if (booking) void notifyStage('delivery_delayed', booking, extra)
    return 'renotified'
  }
  return null
}

/** One pass. Exported so it can be driven from a script. */
export async function runDelayTick(now = Date.now()): Promise<Record<string, number>> {
  // Due around today and not at the pick-up yet, plus any still flagged (to
  // clear them). A booking a few days overdue still unstarted stays in view.
  const [due, flagged] = await Promise.all([
    supabase.from('bookings').select(COLUMNS)
      .in('status', DUE_STATUSES)
      .is('pickup_arrived_at', null)
      .gte('schedule_date', phDay(now - 3 * DAY_MS))
      .lte('schedule_date', phDay(now + DAY_MS)),
    supabase.from('bookings').select(COLUMNS).not('delayed_since', 'is', null),
  ])
  if (due.error) throw due.error
  if (flagged.error) throw flagged.error

  const rows = new Map<string, BookingRow>()
  for (const r of [...(due.data ?? []), ...(flagged.data ?? [])] as unknown as BookingRow[]) rows.set(r.booking_id, r)

  const counts: Record<string, number> = { set: 0, cleared: 0, renotified: 0, arrived: 0 }
  for (const b of rows.values()) {
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
    message:    `Delay tick: ${counts.set} delayed at pick-up, ${counts.arrived} arrived, ${counts.cleared} cleared, ${counts.renotified} re-notified`,
    metadata:   { checked: rows.size, ...counts },
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
