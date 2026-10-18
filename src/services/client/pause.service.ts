import PauseModel from '../../models/client/pause.model.js'
import TripModel from '../../models/client/trip.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { broadcast } from '../../lib/realtime.js'
import { supabase } from '../../lib/supabase.js'
import { notifyStage } from '../notification/notification.service.js'
import { createReportService } from '../driver/report.service.js'
import { refreshPlannedEta } from '../maps/planned-eta.service.js'
import { invalidateEta } from '../maps/eta.service.js'
import { assertLeadDriverOnBooking, type DriverActor } from './booking.service.js'
import {
  PAUSE_REASON_LABEL,
  type BookingPause,
  type BookingPauseWithActors,
  type PauseTripInput,
  type ResumedVia,
} from '../../types/client/pause.types.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'
import { fromDeviceClock } from '../../lib/device-clock.js'

/**
 * The driver pauses a delivery — weather, a breakdown, a closed pickup or
 * drop-off — and says why; the web shows it on the booking until it ends.
 *
 * A pause sits ON TOP of the booking's status ('assigned' or 'in_transit'),
 * never instead of it, so pings, stop confirmations and the offline queue are
 * untouched by it. Everything here is idempotent because the app sends it
 * through the offline queue: pausing a paused booking, or resuming a moving one,
 * returns what stands.
 *
 * It ends three ways: the driver presses Resume, Operations or the Company
 * Administrator ends it from the web, or the driver confirms a pickup or
 * drop-off — a truck unloading at a bay is plainly not paused any more.
 */

/** Roles that may end a pause from the web. */
export const PAUSE_STAFF_ROLES = ['admin', 'it_admin', 'operations_manager']

// A pause is stamped with the moment the driver pressed it, which reaches us
// late from a dead zone. Trust it within these bounds and no further: a clock
// set to tomorrow, or a pause queued for days, must not rewrite the timeline.
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000
const MAX_DELAY_MS       = 24 * 60 * 60 * 1000

function deviceTime(iso: string | null | undefined, notBefore?: string): string {
  const now  = Date.now()
  // The phone's clock, corrected by how far off it was when it sent this.
  const at   = fromDeviceClock(iso) ?? NaN
  let   when = Number.isFinite(at) && at <= now + MAX_FUTURE_SKEW_MS && at >= now - MAX_DELAY_MS
    ? Math.min(at, now)
    : now
  // A resume can't be earlier than the pause it ends.
  if (notBefore) when = Math.max(when, Date.parse(notBefore))
  return new Date(when).toISOString()
}

/** "2 h 15 min", "40 min" — how long a pause lasted, for the office's notice. */
function durationLabel(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** A delay this long or longer earns the client a new expected arrival in the resume notice. */
const NOTIFY_SHIFT_MIN = 30

/**
 * "4:35 – 5:05 PM", or "Oct 18, 4:35 – 5:05 PM" when not today — the same
 * 30-minute window (start rounded down to 5 min) the web shows, in Manila time.
 */
function arrivalWindowPh(iso: string): string {
  const ROUND = 5 * 60_000
  const start = new Date(Math.floor(Date.parse(iso) / ROUND) * ROUND)
  const end   = new Date(start.getTime() + 30 * 60_000)
  const opts  = { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' } as const
  const day   = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' })
  const today = day(new Date())
  const range = `${start.toLocaleTimeString('en-US', opts)} – ${end.toLocaleTimeString('en-US', opts)}`
  return day(start) === today ? range : `${day(start)}, ${range}`
}

/**
 * Tell anyone watching the booking live (web Transit Tracking, the client's
 * tracking page) that its pause changed. Sent as `route_changed`, the event
 * those maps already re-read the route AND the booking on. Best effort.
 */
function announcePauseChanged(bookingId: string): void {
  void broadcast(`route:booking:${bookingId}`, 'route_changed', { booking_id: bookingId })
    .catch(() => {})
}

/** The run the truck is out on, if it has left with a load. */
async function currentTripId(bookingId: string): Promise<string | null> {
  try {
    const trips = await TripModel.findByBookingId(bookingId)
    return trips.find((t) => t.status === 'in_transit')?.trip_id ?? null
  } catch {
    return null
  }
}

async function driverIdForUser(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return null
  return (data as { driver_id?: string } | null)?.driver_id ?? null
}

/* ── Pausing ──────────────────────────────────────────────────────────────── */

export async function pauseTripService(
  bookingId: string,
  input: PauseTripInput,
  actor: DriverActor,
): Promise<BookingWithRelations> {
  const booking = await assertLeadDriverOnBooking(bookingId, actor)

  // Already paused: the queue is retrying, or the driver tapped twice. The
  // first pause stands — its reason and time are the true ones.
  if (await PauseModel.findOpen(bookingId)) return booking

  if (booking.status !== 'assigned' && booking.status !== 'in_transit') {
    throw new Error(`Cannot pause a delivery that is '${booking.status}'`)
  }

  const note = input.note.trim()
  const pausedAt = deviceTime(input.paused_at)

  const pause = await PauseModel.open({
    booking_id: bookingId,
    trip_id:    await currentTripId(bookingId),
    reason:     input.reason,
    note,
    paused_by:  actor.userId ?? null,
    paused_at:  pausedAt,
    latitude:   input.latitude   ?? null,
    longitude:  input.longitude  ?? null,
    accuracy_m: input.accuracy_m ?? null,
  })
  // Lost a race with an identical retry; that one did the work.
  if (!pause) return booking

  await PauseModel.setBookingPause(bookingId, {
    paused_at:    pausedAt,
    pause_reason: input.reason,
    pause_note:   note,
  })

  const label = PAUSE_REASON_LABEL[input.reason]

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'driver_trip_paused',
    description: `Driver paused booking ${bookingRef(booking)} — ${label}: ${note}`,
  })

  // A breakdown is also a vehicle problem, and vehicle problems live in the
  // Reports queue the Fleet Manager works from.
  if (input.reason === 'vehicle_breakdown') {
    void fileBreakdownReport(pause, booking, actor)
  }

  // The cached live ETA was "now + drive time" from a moving truck. Drop it: the
  // screens show "Paused", and a fresh one is bought after the resume.
  void invalidateEta(bookingId).catch(() => {})

  void notifyStage('trip_paused', booking, { pauseLabel: label })
  void notifyStage('trip_paused_staff', booking, { pauseLabel: label, reason: note })
  announcePauseChanged(bookingId)

  return (await BookingModel.findById(bookingId)) ?? booking
}

async function fileBreakdownReport(
  pause: BookingPause,
  booking: BookingWithRelations,
  actor: DriverActor,
): Promise<void> {
  try {
    const driverId = await driverIdForUser(actor.userId)
    // An admin acting on the booking isn't a driver, and a report needs one.
    if (!driverId) return

    const report = await createReportService(driverId, {
      booking_id:        booking.booking_id,
      source:            'detailed',
      incident_type:     'vehicle_breakdown',
      description:       `Delivery paused for a vehicle breakdown: ${pause.note}`,
      latitude:          pause.latitude,
      longitude:         pause.longitude,
      accuracy_m:        pause.accuracy_m,
      trip_can_continue: false,
    }, actor)

    await PauseModel.linkReport(pause.pause_id, report.report_id)
  } catch (err) {
    // The pause stands without it; the driver can still file a report by hand.
    console.error('[pause] could not file the breakdown report', booking.booking_id, err)
  }
}

/* ── Resuming ─────────────────────────────────────────────────────────────── */

interface ResumeOptions {
  via:         ResumedVia
  /** When the driver pressed Resume, as the phone recorded it. */
  resumedAt?:  string | null
  note?:       string | null
}

async function endPause(
  booking: BookingWithRelations,
  actor: DriverActor,
  opts: ResumeOptions,
): Promise<BookingWithRelations> {
  const open = await PauseModel.findOpen(booking.booking_id)
  if (!open) return booking

  const resumedAt = opts.via === 'driver'
    ? deviceTime(opts.resumedAt, open.paused_at)
    : new Date().toISOString()
  const note = opts.note?.trim() || null

  const closedHere = await PauseModel.close(open.pause_id, {
    resumed_at:  resumedAt,
    resumed_by:  actor.userId ?? null,
    resumed_via: opts.via,
    resume_note: note,
  })
  // Someone else ended it a moment ago; they cleared the booking and told
  // everyone. Hand back what stands rather than announcing it twice.
  if (!closedHere) return (await BookingModel.findById(booking.booking_id)) ?? booking

  await PauseModel.setBookingPause(booking.booking_id, {
    paused_at: null, pause_reason: null, pause_note: null,
  })

  const pausedFor = durationLabel(open.paused_at, resumedAt)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      opts.via === 'staff' ? 'staff_trip_resumed' : 'driver_trip_resumed',
    description:
      `Booking ${bookingRef(booking)} resumed after ${pausedFor} ` +
      (opts.via === 'staff' ? 'by the office' : opts.via === 'auto' ? '(driver confirmed a stop)' : 'by the driver') +
      (note ? `: ${note}` : ''),
  })

  // The pause moved every arrival after it. Re-plan (pause time is added in
  // refreshPlannedEta) and let the next ping buy a fresh live ETA.
  const before = (booking as { estimated_delivery?: string | null }).estimated_delivery ?? null
  await refreshPlannedEta(booking.booking_id)
  void invalidateEta(booking.booking_id).catch(() => {})
  const replanned = await BookingModel.findById(booking.booking_id)
  const after = (replanned as { estimated_delivery?: string | null } | null)?.estimated_delivery ?? null
  const shiftMin = before && after ? (Date.parse(after) - Date.parse(before)) / 60_000 : 0

  void notifyStage('trip_resumed', replanned ?? booking, {
    newArrival: after && shiftMin >= NOTIFY_SHIFT_MIN ? arrivalWindowPh(after) : undefined,
  })
  if (opts.via === 'staff') {
    void notifyStage('trip_resumed_by_staff', booking, { reason: note })
  } else {
    void notifyStage('trip_resumed_staff', booking, { pausedFor })
  }
  announcePauseChanged(booking.booking_id)

  return (await BookingModel.findById(booking.booking_id)) ?? booking
}

/** The driver pressed Resume. */
export async function driverResumeTripService(
  bookingId: string,
  actor: DriverActor,
  resumedAt?: string | null,
): Promise<BookingWithRelations> {
  const booking = await assertLeadDriverOnBooking(bookingId, actor)
  return endPause(booking, actor, { via: 'driver', resumedAt })
}

/** Operations or the Company Administrator ended the pause from the web. */
export async function staffResumeTripService(
  bookingId: string,
  actor: DriverActor,
  note?: string | null,
): Promise<BookingWithRelations> {
  if (!actor.role || !PAUSE_STAFF_ROLES.includes(actor.role)) {
    throw new Error('You are not allowed to resume this delivery')
  }
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  return endPause(booking, actor, { via: 'staff', note })
}

/**
 * The driver confirmed a pickup or drop-off while paused: the truck is moving.
 * Called from the confirmation paths; never fails them.
 */
export async function endPauseOnProgress(bookingId: string, actor: DriverActor): Promise<void> {
  try {
    const booking = await BookingModel.findById(bookingId)
    if (!booking || !(booking as { paused_at?: string | null }).paused_at) return
    await endPause(booking, actor, { via: 'auto' })
  } catch (err) {
    console.error('[pause] could not end the pause on progress', bookingId, err)
  }
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** The staff timeline: every pause, with the driver's notes and who ended it. */
export function listPausesService(bookingId: string): Promise<BookingPauseWithActors[]> {
  return PauseModel.findByBookingId(bookingId)
}
