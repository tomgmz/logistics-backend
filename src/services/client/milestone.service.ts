import { supabase } from '../../lib/supabase.js'
import { pool } from '../../lib/database.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { assertCrewDriverOnBooking, type DriverActor } from './booking.service.js'
import { resolveTripByNumber, resolveTripStopByDestination } from './trip.service.js'
import { driverIdOf } from '../driver/crew-actor.js'
import { fromDeviceClock, hasDeviceClock } from '../../lib/device-clock.js'

/**
 * The times at each stop visit — see the stop_milestones migrations.
 *
 *   arrived → started → finished → proof
 *
 * `arrived` is sent by the phone on its own when navigation detects the arrival
 * (or the driver's "I've arrived" within 300 m of the stop); `started` is "Start
 * loading" / "Start unloading"; `finished` is "Loading finished" / "Unloading
 * finished" (its own step since 2026-11-12, migration
 * 20261112000000_stop_times_finished; before that "finished" was the proof
 * time). `proof` is not stored here: it IS the proof confirmation (the run's
 * pickup_proof_at, the visit's delivered_at). An older app sends no `finished`;
 * its proof is still accepted and the step reads as not recorded. The office
 * can fill in or correct arrived, started and finished.
 */

export const MILESTONE_STAGES = ['arrived', 'started', 'finished'] as const
export type MilestoneStage = typeof MILESTONE_STAGES[number]

/**
 * Steps an older app still sends from its queue. `arrived_parking` is the
 * arrival under its old name; docking and departure are no longer recorded and
 * are accepted and dropped, so a queued one never blocks what is behind it.
 */
const LEGACY_ALIAS: Record<string, MilestoneStage | null> = {
  arrived_parking: 'arrived',
  docked:          null,
  departed:        null,
}

/** Order of the steps, the proof included, for the "never before the step before" bound. */
const ORDER = ['arrived', 'started', 'finished', 'proof'] as const

/** "I've arrived" / a detected arrival must be this close to the stop (user 2026-11-12). */
export const ARRIVAL_RADIUS_M = 300

/**
 * A tap that reached us within this long of when the phone says it happened is
 * timed by our clock, not the phone's: it was sent live, and the phone's clock
 * is the one thing in this exchange the driver can set.
 */
const LIVE_WINDOW_MS = 2 * 60_000

/** A tap moved by more than this to keep the steps in order is flagged. */
const CLOCK_FLAG_MS = 60_000

export interface StepTime {
  at:         string
  /**
   * 'office' = a picked-up / delivered time the office recorded in place of the
   * driver, with no photo (2026-11-28). It reads "recorded by the office", never
   * "proof sent", and the office may correct it.
   */
  source:     'driver' | 'staff' | 'proof' | 'office'
  corrected?: boolean
  note?:      string | null
  /** The phone's clock had to be overridden to keep the steps in order. */
  clock_adjusted?: boolean
}

export interface StopTimes {
  arrived:  StepTime | null
  started:  StepTime | null
  /** "Loading/Unloading finished". Null on a visit an older app confirmed (no such step then). */
  finished: StepTime | null
  /** The proof confirmation (photo). */
  proof:    StepTime | null
}

export interface TimelineStop extends StopTimes {
  trip_stop_id:   string
  destination_id: string
  sequence_order: number
  stop_number:    number | null
  address:        string | null
  status:         string
}

export interface TimelineTrip {
  trip_id:     string
  trip_number: number
  status:      string
  /** Total goods loaded on this run — null until it is loaded. */
  total_loaded: { pieces: number; weight_kg: number | null } | null
  loading:     StopTimes
  stops:       TimelineStop[]
}

const emptyTimes = (): StopTimes => ({ arrived: null, started: null, finished: null, proof: null })

/** The office confirmed the stop for the driver (trip.service stopFence writes this prefix). */
const OFFICE_REASON = /^Confirmed by the office/i
/**
 * A corrected office time is marked by this tag in the same reason column,
 * followed by why (no new column; the previous time is in the audit log).
 */
const CORRECTED_TAG = ' · Time corrected: '

const officeRecorded = (photo: unknown, reason: unknown) =>
  !photo && typeof reason === 'string' && OFFICE_REASON.test(reason)

/** The picked-up / delivered step: a photo confirmation, or the office's record of one. */
function proofStep(at: unknown, photo: unknown, reason: unknown, withNotes: boolean): StepTime {
  const iso = at instanceof Date ? at.toISOString() : String(at)
  if (!officeRecorded(photo, reason)) return { at: iso, source: 'proof' }
  const text = String(reason)
  const cut  = text.lastIndexOf(CORRECTED_TAG)
  return {
    at: iso,
    source: 'office',
    ...(cut >= 0 ? { corrected: true } : {}),
    ...(withNotes && cut >= 0 ? { note: text.slice(cut + CORRECTED_TAG.length) } : {}),
  }
}
const shownStage = (stage: string): stage is MilestoneStage => (MILESTONE_STAGES as readonly string[]).includes(stage)

/** Every run of the booking, with the times at its loading and each drop-off. */
export async function bookingTimeline(bookingId: string, { withNotes = false } = {}): Promise<TimelineTrip[]> {
  const [{ rows: trips }, { rows: stops }, { rows: marks }, { rows: loaded }] = await Promise.all([
    pool.query(
      `SELECT trip_id, trip_number, status, pickup_proof_at, pickup_proof_photo_url, pickup_proof_override_reason
         FROM booking_trips WHERE booking_id = $1 AND status <> 'cancelled' ORDER BY trip_number`,
      [bookingId]),
    pool.query(
      `SELECT s.trip_stop_id, s.trip_id, s.destination_id, s.sequence_order, s.status, s.delivered_at,
              s.proof_photo_url, s.proof_override_reason,
              d.address, d.sequence_order AS stop_number
         FROM booking_trip_stops s
         JOIN booking_trips t ON t.trip_id = s.trip_id
         LEFT JOIN booking_destinations d ON d.destination_id = s.destination_id
        WHERE t.booking_id = $1
        ORDER BY s.sequence_order`,
      [bookingId]),
    pool.query(
      `SELECT trip_id, trip_stop_id, stage, at, source, corrected_at, correction_note, clock_adjusted
         FROM stop_milestones WHERE booking_id = $1`,
      [bookingId]),
    pool.query(
      `SELECT tc.trip_id,
              SUM(tc.loaded_qty)::float AS pieces,
              SUM(CASE WHEN c.weight_kg IS NOT NULL AND c.quantity > 0
                       THEN c.weight_kg * tc.loaded_qty / c.quantity END)::float AS weight_kg,
              COUNT(tc.loaded_qty) AS loaded_lines
         FROM booking_trip_cargo tc
         JOIN booking_cargo_items c ON c.item_id = tc.item_id
        WHERE tc.booking_id = $1
        GROUP BY tc.trip_id`,
      [bookingId]),
  ])

  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))
  const step = (m: any): StepTime => ({
    at:     iso(m.at),
    source: m.source,
    ...(m.corrected_at ? { corrected: true } : {}),
    ...(m.clock_adjusted && !m.corrected_at ? { clock_adjusted: true } : {}),
    ...(withNotes && m.correction_note ? { note: m.correction_note } : {}),
  })

  return trips.map((t: any) => {
    const loading = emptyTimes()
    if (t.pickup_proof_at) loading.proof = proofStep(t.pickup_proof_at, t.pickup_proof_photo_url, t.pickup_proof_override_reason, withNotes)
    for (const m of marks) {
      const st: string = m.stage
      if (m.trip_id === t.trip_id && !m.trip_stop_id && shownStage(st)) loading[st] = step(m)
    }
    const total = loaded.find((l: any) => l.trip_id === t.trip_id && Number(l.loaded_lines) > 0)
    return {
      trip_id:      t.trip_id,
      trip_number:  t.trip_number,
      status:       t.status,
      total_loaded: total ? { pieces: Number(total.pieces ?? 0), weight_kg: total.weight_kg != null ? Math.round(Number(total.weight_kg) * 10) / 10 : null } : null,
      loading,
      stops: stops.filter((s: any) => s.trip_id === t.trip_id).map((s: any) => {
        const times = emptyTimes()
        if (s.delivered_at) times.proof = proofStep(s.delivered_at, s.proof_photo_url, s.proof_override_reason, withNotes)
        for (const m of marks) {
          const st: string = m.stage
          if (m.trip_stop_id === s.trip_stop_id && shownStage(st)) times[st] = step(m)
        }
        return {
          trip_stop_id:   s.trip_stop_id,
          destination_id: s.destination_id,
          sequence_order: s.sequence_order,
          stop_number:    s.stop_number != null ? Number(s.stop_number) : null,
          address:        s.address ?? null,
          status:         s.status,
          ...times,
        }
      }),
    }
  })
}

interface Target { tripId: string; tripStopId: string | null }

/** Trip / drop-off by server id, or by number + drop-off for ones the phone made offline. */
async function resolveTarget(bookingId: string, body: Record<string, any>): Promise<Target> {
  const tripId = typeof body.trip_id === 'string' && body.trip_id
    ? body.trip_id
    : await resolveTripByNumber(bookingId, Number(body.trip_number))
  const { data: trip } = await supabase.from('booking_trips').select('booking_id').eq('trip_id', tripId).maybeSingle()
  if (!trip || trip.booking_id !== bookingId) throw new Error('Trip not found on this booking')

  let tripStopId: string | null = null
  if (typeof body.trip_stop_id === 'string' && body.trip_stop_id) {
    const { data: stop } = await supabase.from('booking_trip_stops').select('trip_id').eq('trip_stop_id', body.trip_stop_id).maybeSingle()
    if (!stop || stop.trip_id !== tripId) throw new Error('That drop-off was not found on this trip')
    tripStopId = body.trip_stop_id
  } else if (typeof body.destination_id === 'string' && body.destination_id) {
    tripStopId = await resolveTripStopByDestination(bookingId, Number(body.trip_number), body.destination_id)
  }
  return { tripId, tripStopId }
}

/** The times already on this stop visit, the proof included, as epoch ms. */
async function timesOf(target: Target): Promise<Partial<Record<typeof ORDER[number], number>>> {
  const out: Partial<Record<typeof ORDER[number], number>> = {}
  const { rows } = await pool.query(
    `SELECT stage, at FROM stop_milestones
      WHERE trip_id = $1 AND trip_stop_id IS NOT DISTINCT FROM $2`,
    [target.tripId, target.tripStopId])
  for (const r of rows) {
    const st: string = r.stage
    if (shownStage(st)) out[st] = new Date(r.at).getTime()
  }
  const { rows: [fin] } = target.tripStopId
    ? await pool.query(`SELECT delivered_at AS at FROM booking_trip_stops WHERE trip_stop_id = $1`, [target.tripStopId])
    : await pool.query(`SELECT pickup_proof_at AS at FROM booking_trips WHERE trip_id = $1`, [target.tripId])
  if (fin?.at) out.proof = new Date(fin.at).getTime()
  return out
}

/** Latest time of any step before `stage` — a step can't come before it. */
function floorFor(stage: typeof ORDER[number], times: Partial<Record<typeof ORDER[number], number>>): number | null {
  const before = ORDER.slice(0, ORDER.indexOf(stage)).map((s) => times[s]).filter((x): x is number => x != null)
  return before.length ? Math.max(...before) : null
}
/** Earliest time of any step after `stage` — a correction can't jump past it. */
function ceilingFor(stage: MilestoneStage, times: Partial<Record<typeof ORDER[number], number>>): number | null {
  const after = ORDER.slice(ORDER.indexOf(stage) + 1).map((s) => times[s]).filter((x): x is number => x != null)
  return after.length ? Math.min(...after) : null
}

const STAGE_LABEL: Record<MilestoneStage, string> = {
  arrived:  'arrival',
  started:  'start of loading or unloading',
  finished: 'end of loading or unloading',
}

/** Where the visit is: the pickup (booking origin) or the drop-off. Null when not on file. */
async function placeOf(bookingId: string, target: Target): Promise<{ lat: number; lng: number } | null> {
  const { rows: [r] } = target.tripStopId
    ? await pool.query(
        `SELECT d.latitude AS lat, d.longitude AS lng FROM booking_trip_stops s
           JOIN booking_destinations d ON d.destination_id = s.destination_id WHERE s.trip_stop_id = $1`,
        [target.tripStopId])
    : await pool.query(`SELECT origin_latitude AS lat, origin_longitude AS lng FROM bookings WHERE booking_id = $1`, [bookingId])
  return r?.lat != null && r?.lng != null ? { lat: Number(r.lat), lng: Number(r.lng) } : null
}

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * A driver's tap. Idempotent (the first tap of a step wins), so the offline
 * queue may re-send it. Main driver only, like every other trip write.
 */
export async function driverRecordMilestoneService(
  bookingId: string,
  body: Record<string, any>,
  actor: DriverActor,
) {
  const raw = String(body.stage ?? '')
  const stage = raw in LEGACY_ALIAS ? LEGACY_ALIAS[raw] : (raw as MilestoneStage)
  if (stage === null) return { recorded: false, ignored: true }
  if (!MILESTONE_STAGES.includes(stage)) throw new Error('Cannot record an unknown step')
  const booking = await assertCrewDriverOnBooking(bookingId, actor)
  if (booking.status !== 'in_transit' && booking.status !== 'delivered' && booking.status !== 'completed' && booking.status !== 'failed') {
    throw new Error('Cannot record stop times before the delivery has started')
  }
  const target = await resolveTarget(bookingId, body)
  const times  = await timesOf(target)

  // No step skipped (user 2026-11-12): finished needs started, started needs
  // arrived. The app runs them in this order; a later step already on file
  // (e.g. the office filled it in) satisfies it too.
  const has = (st: typeof ORDER[number]) => times[st] != null || ORDER.slice(ORDER.indexOf(st) + 1).some((x) => times[x] != null)
  if (stage === 'started'  && !has('arrived')) throw new Error('Cannot start before the arrival is recorded')
  if (stage === 'finished' && !has('started')) throw new Error('Cannot finish before loading or unloading has started')

  // The arrival is logged at the stop, not before (user 2026-11-12: within
  // 300 m). Checked when the phone sent its position; the GPS accuracy is given
  // the benefit of the doubt. No position (an older app) is not refused.
  if (stage === 'arrived' && typeof body.latitude === 'number' && typeof body.longitude === 'number') {
    const place = await placeOf(bookingId, target)
    if (place) {
      const off = metresBetween(place, { lat: body.latitude, lng: body.longitude })
      const slack = typeof body.accuracy_m === 'number' ? Math.min(Math.max(body.accuracy_m, 0), 100) : 0
      if (off - slack > ARRIVAL_RADIUS_M) {
        throw new Error(`Cannot record the arrival ${Math.round(off)} m from the stop; it must be within ${ARRIVAL_RADIUS_M} m`)
      }
    }
  }

  // When it happened: the phone's time of the tap, corrected by how far off the
  // phone's clock was when it sent this request (lib/device-clock). An app that
  // sends no clock header falls back to the old rule: our clock if the tap came
  // in live, the phone's (already server-corrected) time if it was queued.
  const received = Date.now()
  const device   = fromDeviceClock(typeof body.at === 'string' ? body.at : null)
  let at = received
  if (device != null) {
    if (hasDeviceClock())                       at = device
    else if (received - device > LIVE_WINDOW_MS) at = device
  }
  // Still out of place only if the phone's clock was changed between the tap and
  // the send: keep it in order, and flag it for the office.
  const unbounded = at
  const floor = floorFor(stage, times)
  const ceil  = ceilingFor(stage, times)
  if (at > received)                at = received
  if (floor != null && at < floor)  at = floor
  if (ceil  != null && at > ceil)   at = ceil
  const clockAdjusted = Math.abs(at - unbounded) > CLOCK_FLAG_MS

  const lat = typeof body.latitude  === 'number' ? body.latitude  : null
  const lng = typeof body.longitude === 'number' ? body.longitude : null
  const { rows: [row] } = await pool.query(
    `INSERT INTO stop_milestones (booking_id, trip_id, trip_stop_id, stage, at, source, driver_id,
                                  device_at, received_at, latitude, longitude, accuracy_m, clock_adjusted)
     VALUES ($1,$2,$3,$4,$5,'driver',$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (trip_id, COALESCE(trip_stop_id, '00000000-0000-0000-0000-000000000000'::uuid), stage) DO NOTHING
     RETURNING *`,
    [bookingId, target.tripId, target.tripStopId, stage, new Date(at).toISOString(), await driverIdOf(actor),
     typeof body.at === 'string' && Number.isFinite(Date.parse(body.at)) ? new Date(body.at).toISOString() : null,
     new Date(received).toISOString(),
     lat, lng, typeof body.accuracy_m === 'number' ? body.accuracy_m : null, clockAdjusted],
  )
  return { recorded: !!row, at: new Date(at).toISOString(), clock_adjusted: clockAdjusted }
}

/** Booking statuses whose stop times the office may fill in or correct. */
export const STOP_TIME_EDITABLE = ['in_transit', 'delivered', 'completed', 'failed']

/**
 * The office fills in or corrects a step (the driver forgot to tap, or tapped
 * late). A reason is required; the previous value goes to the audit log.
 */
export async function staffSetMilestoneService(
  bookingId: string,
  body: { trip_id: string; trip_stop_id?: string | null; stage: MilestoneStage | 'proof'; at: string; note: string },
  staff: { userId: string | null },
) {
  if (body.stage === 'proof') {
    return staffSetOfficeProofTime(bookingId, { ...body, stage: 'proof' }, staff)
  }
  if (!MILESTONE_STAGES.includes(body.stage)) throw new Error('Cannot set an unknown step')
  const note = body.note?.trim() ?? ''
  if (note.length < 3) throw new Error('Say why the time is being changed')
  const at = Date.parse(body.at)
  if (!Number.isFinite(at)) throw new Error('Cannot read that time')
  if (at > Date.now() + 60_000) throw new Error('Cannot set a time in the future')

  // Stop times are what happened on the road, so there is nothing to fill in
  // before the delivery has started (Assigned = the truck hasn't left yet).
  // Corrections stay open after delivery; each one is in the audit log.
  const { data: bk } = await supabase.from('bookings').select('status').eq('booking_id', bookingId).maybeSingle()
  if (!bk) throw new Error('Booking not found')
  if (!STOP_TIME_EDITABLE.includes(bk.status)) {
    throw new Error('Cannot set stop times before the delivery has started')
  }

  const target = await resolveTarget(bookingId, body)
  // A drop-off can't be reached before its run was loaded.
  if (target.tripStopId) {
    const { data: trip } = await supabase.from('booking_trips').select('status').eq('trip_id', target.tripId).maybeSingle()
    if (trip && trip.status !== 'in_transit' && trip.status !== 'completed') {
      throw new Error('Cannot set a drop-off time before this run was loaded')
    }
  }
  const times  = await timesOf(target)
  const floor  = floorFor(body.stage, times)
  const ceil   = ceilingFor(body.stage, times)
  if (floor != null && at < floor) throw new Error(`Cannot set the ${STAGE_LABEL[body.stage]} before the step before it`)
  if (ceil  != null && at > ceil)  throw new Error(`Cannot set the ${STAGE_LABEL[body.stage]} after the step after it`)

  const { rows: [previous] } = await pool.query(
    `SELECT at, source FROM stop_milestones
      WHERE trip_id = $1 AND trip_stop_id IS NOT DISTINCT FROM $2 AND stage = $3`,
    [target.tripId, target.tripStopId, body.stage])

  const now = new Date().toISOString()
  await pool.query(
    `INSERT INTO stop_milestones (booking_id, trip_id, trip_stop_id, stage, at, source, received_at,
                                  corrected_by, corrected_at, correction_note)
     VALUES ($1,$2,$3,$4,$5,'staff',$6,$7,$6,$8)
     ON CONFLICT (trip_id, COALESCE(trip_stop_id, '00000000-0000-0000-0000-000000000000'::uuid), stage)
     DO UPDATE SET at = EXCLUDED.at, corrected_by = EXCLUDED.corrected_by, corrected_at = EXCLUDED.corrected_at,
                   correction_note = EXCLUDED.correction_note, updated_at = EXCLUDED.corrected_at`,
    [bookingId, target.tripId, target.tripStopId, body.stage, new Date(at).toISOString(), now, staff.userId, note],
  )

  const booking = await BookingModel.findById(bookingId)
  logEvent({
    user_id:     staff.userId,
    log_type:    'booking',
    action:      previous ? 'stop_time_corrected' : 'stop_time_filled_in',
    description:
      `Booking ${booking ? bookingRef(booking) : bookingId}: ${STAGE_LABEL[body.stage]} at ` +
      `${target.tripStopId ? `drop-off visit ${target.tripStopId}` : `the loading of trip ${target.tripId}`} ` +
      (previous ? `changed from ${new Date(previous.at).toISOString()} (${previous.source}) ` : 'filled in ') +
      `to ${new Date(at).toISOString()}. Reason: ${note}`,
  })
  return bookingTimeline(bookingId, { withNotes: true })
}

/**
 * The office corrects the picked-up / delivered time of a stop IT recorded for
 * the driver (user 2026-11-28). Confirming for the driver stamps the moment the
 * office pressed the button, often hours after the truck was really there, and
 * that time was locked like a driver's photo time.
 *
 * Only an office record with no photo: a driver's photo carries its own stamped
 * time, and the record must not disagree with its evidence. Same rules as the
 * other steps: a reason, never in the future, never before the step before it
 * (and a drop-off never before its run's loading; a loading never after its
 * run's first drop-off). The previous time goes to the audit log; the reason is
 * kept with the stop (CORRECTED_TAG), so the time reads "(corrected)".
 *
 * Moves the stop's own time only. The booking's finish time (and the client's
 * 3-day confirmation window counted from it) stays when the booking was
 * actually closed.
 */
async function staffSetOfficeProofTime(
  bookingId: string,
  body: { trip_id: string; trip_stop_id?: string | null; stage: 'proof'; at: string; note: string },
  staff: { userId: string | null },
) {
  const note = body.note?.trim() ?? ''
  if (note.length < 3) throw new Error('Say why the time is being changed')
  const at = Date.parse(body.at)
  if (!Number.isFinite(at)) throw new Error('Cannot read that time')
  if (at > Date.now() + 60_000) throw new Error('Cannot set a time in the future')

  const { data: bk } = await supabase.from('bookings').select('status').eq('booking_id', bookingId).maybeSingle()
  if (!bk) throw new Error('Booking not found')
  if (!STOP_TIME_EDITABLE.includes(bk.status)) {
    throw new Error('Cannot set stop times before the delivery has started')
  }

  const target = await resolveTarget(bookingId, body)
  const times  = await timesOf(target)
  const floor  = floorFor('proof', times)
  const newAt  = new Date(at).toISOString()
  const keep   = (reason: string) => {
    const base = reason.includes(CORRECTED_TAG) ? reason.slice(0, reason.indexOf(CORRECTED_TAG)) : reason
    return `${base}${CORRECTED_TAG}${note}`
  }

  let previous: Date
  let where: string
  if (target.tripStopId) {
    const { rows: [s] } = await pool.query(
      `SELECT s.status, s.delivered_at, s.proof_photo_url, s.proof_override_reason, s.destination_id,
              t.pickup_proof_at, d.address
         FROM booking_trip_stops s
         JOIN booking_trips t ON t.trip_id = s.trip_id
         LEFT JOIN booking_destinations d ON d.destination_id = s.destination_id
        WHERE s.trip_stop_id = $1`,
      [target.tripStopId])
    if (!s || s.status !== 'delivered' || !s.delivered_at) throw new Error('This drop-off has not been delivered yet')
    if (!officeRecorded(s.proof_photo_url, s.proof_override_reason)) {
      throw new Error('Only a delivery the office recorded without a photo can have its time changed; a driver’s photo time is the record')
    }
    if (floor != null && at < floor) throw new Error('Cannot set the delivery before the step before it')
    if (s.pickup_proof_at && at < new Date(s.pickup_proof_at).getTime()) {
      throw new Error('Cannot set the delivery before this run was loaded')
    }
    previous = new Date(s.delivered_at)
    where = `drop-off ${s.address ?? target.tripStopId}`
    await pool.query(
      `UPDATE booking_trip_stops SET delivered_at = $2, proof_override_reason = $3, updated_at = now()
        WHERE trip_stop_id = $1`,
      [target.tripStopId, newAt, keep(String(s.proof_override_reason))])
    // The drop-off's own time, when this visit is the one that closed it.
    await pool.query(
      `UPDATE booking_destinations SET delivered_at = $2
        WHERE destination_id = $1 AND delivered_at = $3 AND proof_photo_url IS NULL`,
      [s.destination_id, newAt, previous])
  } else {
    const { rows: [t] } = await pool.query(
      `SELECT trip_number, pickup_proof_at, pickup_proof_photo_url, pickup_proof_override_reason
         FROM booking_trips WHERE trip_id = $1`,
      [target.tripId])
    if (!t || !t.pickup_proof_at) throw new Error('This run has not been loaded yet')
    if (!officeRecorded(t.pickup_proof_photo_url, t.pickup_proof_override_reason)) {
      throw new Error('Only a loading the office recorded without a photo can have its time changed; a driver’s photo time is the record')
    }
    if (floor != null && at < floor) throw new Error('Cannot set the pick-up before the step before it')
    // Nothing on this run can be unloaded (or even reached) before it was loaded.
    const { rows: [first] } = await pool.query(
      `SELECT LEAST(
                (SELECT MIN(m.at) FROM stop_milestones m WHERE m.trip_id = $1 AND m.trip_stop_id IS NOT NULL),
                (SELECT MIN(s.delivered_at) FROM booking_trip_stops s WHERE s.trip_id = $1)
              ) AS at`,
      [target.tripId])
    if (first?.at && at > new Date(first.at).getTime()) {
      throw new Error('Cannot set the pick-up after this run’s first drop-off')
    }
    previous = new Date(t.pickup_proof_at)
    where = `the loading of trip ${t.trip_number}`
    await pool.query(
      `UPDATE booking_trips SET pickup_proof_at = $2, pickup_proof_override_reason = $3, updated_at = now()
        WHERE trip_id = $1`,
      [target.tripId, newAt, keep(String(t.pickup_proof_override_reason))])
    // The booking's pick-up time, when this is the first run's (no photo on it).
    await pool.query(
      `UPDATE bookings SET pickup_proof_at = $2
        WHERE booking_id = $1 AND pickup_proof_at = $3 AND pickup_proof_photo_url IS NULL`,
      [bookingId, newAt, previous])
  }

  const booking = await BookingModel.findById(bookingId)
  logEvent({
    user_id:     staff.userId,
    log_type:    'booking',
    action:      'stop_time_corrected',
    description:
      `Booking ${booking ? bookingRef(booking) : bookingId}: office-recorded ${target.tripStopId ? 'delivery' : 'pick-up'} time at ` +
      `${where} changed from ${previous.toISOString()} to ${newAt}. Reason: ${note}`,
  })
  return bookingTimeline(bookingId, { withNotes: true })
}
