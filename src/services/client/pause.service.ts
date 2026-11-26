import PauseModel from '../../models/client/pause.model.js'
import TripModel from '../../models/client/trip.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { broadcast } from '../../lib/realtime.js'
import { notifyStage } from '../notification/notification.service.js'
import { createReportService } from '../driver/report.service.js'
import { clearBreakdown } from './breakdown.service.js'
import { continuationAt } from '../maps/stop-allowances.js'
import { requestPauseContinuationCheck } from '../notification/pause-continuation.scheduler.js'
import { invalidateEta } from '../maps/eta.service.js'
import { assertCrewDriverOnBooking, type DriverActor } from './booking.service.js'
import { confirmedAtMs } from '../driver/late-confirmation.service.js'
import { pool } from '../../lib/database.js'
import {
  PAUSE_REASON_LABEL,
  resumeRequestOpen,
  type BookingPause,
  type BookingPauseWithActors,
  type PauseTripInput,
  type PauseContinuationInput,
  type ResumeRequestInput,
} from '../../types/client/pause.types.js'
import type { BookingWithRelations } from '../../types/client/booking.types.js'

/**
 * Operations or the Company Administrator pauses a delivery on the road —
 * weather, a breakdown, a closed pickup or drop-off — and says why; the web
 * shows it on the booking, and the driver's app shows it, until the office ends
 * it. The driver can neither pause nor resume: they call the office.
 *
 * A pause sits ON TOP of the booking's status ('in_transit'), never instead of
 * it, so pings, stop confirmations and the offline queue are untouched by it.
 * Confirming a stop does NOT end it — only the office does.
 */

/** Roles that may pause and end a pause: the Company Administrator and the Operations Manager. */
export const PAUSE_STAFF_ROLES = ['admin', 'operations_manager']

function assertPauseDesk(actor: DriverActor, action: 'pause' | 'resume'): void {
  if (!actor.role || !PAUSE_STAFF_ROLES.includes(actor.role)) {
    throw new Error(`You are not allowed to ${action} this delivery`)
  }
}

/** "2 h 15 min", "40 min" — how long a pause lasted, for the office's notice. */
function durationLabel(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
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

/** The main driver on the booking — the breakdown report is filed in their name. */
function leadDriverId(booking: BookingWithRelations): string | null {
  const crew = ((booking as { driver_assignments?: { driver_id: string; crew_role?: string | null; assigned_at?: string | null }[] })
    .driver_assignments ?? [])
    .filter((a) => a.crew_role !== 'second')
    .sort((a, b) => Date.parse(b.assigned_at ?? '') - Date.parse(a.assigned_at ?? ''))
  return crew[0]?.driver_id ?? null
}

/* ── Pausing ──────────────────────────────────────────────────────────────── */

export async function staffPauseTripService(
  bookingId: string,
  input: PauseTripInput,
  actor: DriverActor,
): Promise<BookingWithRelations> {
  assertPauseDesk(actor, 'pause')
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  // Already paused: someone else at the desk got there first. Their pause
  // stands — its reason and time are the true ones.
  if (await PauseModel.findOpen(bookingId)) return booking

  if (booking.status !== 'in_transit') {
    throw new Error('Cannot pause a delivery that is not in transit')
  }

  const note = input.note.trim()
  const pausedAt = new Date().toISOString()

  const pause = await PauseModel.open({
    booking_id: bookingId,
    trip_id:    await currentTripId(bookingId),
    reason:     input.reason,
    note,
    paused_by:  actor.userId ?? null,
    paused_at:  pausedAt,
    latitude:   null,
    longitude:  null,
    accuracy_m: null,
  })
  // Lost a race with a second click; that one did the work.
  if (!pause) return booking

  await PauseModel.setBookingPause(bookingId, {
    paused_at:    pausedAt,
    pause_reason: input.reason,
    pause_note:   note,
  })
  // A breakdown the driver reported was waiting for this decision.
  const driverReportId = (booking as { breakdown_report_id?: string | null }).breakdown_report_id ?? null
  void clearBreakdown(bookingId).catch((err) => console.error('[pause] clearing the breakdown flag failed', bookingId, err))

  const label = PAUSE_REASON_LABEL[input.reason]

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'staff_trip_paused',
    description: `Booking ${bookingRef(booking)} paused by the office — ${label}: ${note}`,
  })

  // A breakdown is also a vehicle problem, and vehicle problems live in the
  // Reports queue the Fleet Manager works from.
  // The driver's own breakdown report already exists: link it rather than file
  // a second one (which would also hold the vehicle twice).
  if (input.reason === 'vehicle_breakdown') {
    if (driverReportId) void PauseModel.linkReport(pause.pause_id, driverReportId).catch(() => {})
    else void fileBreakdownReport(pause, booking, actor)
  }

  // The cached live ETA was "now + drive time" from a moving truck. Drop it: the
  // screens show "Paused", and a fresh one is bought after the resume.
  void invalidateEta(bookingId).catch(() => {})

  void notifyStage('trip_paused', booking, { pauseLabel: label })
  void notifyStage('trip_paused_by_staff', booking, { pauseLabel: label, reason: note })
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
    // Filed in the main driver's name: a report needs a driver, and it is their truck.
    const driverId = leadDriverId(booking)
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
    // The pause stands without it; a report can still be filed by hand.
    console.error('[pause] could not file the breakdown report', booking.booking_id, err)
  }
}

/* ── Resuming ─────────────────────────────────────────────────────────────── */

/** Operations or the Company Administrator ended the pause from the web. */
export async function staffResumeTripService(
  bookingId: string,
  actor: DriverActor,
  note?: string | null,
): Promise<BookingWithRelations> {
  assertPauseDesk(actor, 'resume')
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  const open = await PauseModel.findOpen(bookingId)
  if (!open) return booking

  const resumedAt = new Date().toISOString()
  const resumeNote = note?.trim() || null

  const closedHere = await PauseModel.close(open.pause_id, {
    resumed_at:  resumedAt,
    resumed_by:  actor.userId ?? null,
    resumed_via: 'staff',
    resume_note: resumeNote,
  })
  // Someone else ended it a moment ago; they cleared the booking and told
  // everyone. Hand back what stands rather than announcing it twice.
  if (!closedHere) return (await BookingModel.findById(bookingId)) ?? booking

  await PauseModel.setBookingPause(bookingId, {
    paused_at: null, pause_reason: null, pause_note: null,
  })

  const pausedFor = durationLabel(open.paused_at, resumedAt)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'staff_trip_resumed',
    description:
      `Booking ${bookingRef(booking)} resumed after ${pausedFor} by the office` +
      (resumeRequestOpen(open) ? ', answering the driver\'s request to continue' : '') +
      (resumeNote ? `: ${resumeNote}` : ''),
  })

  // The pause moved every arrival after it: the next ping buys a fresh live
  // ETA, which the client sees on the tracking page (no planned time to quote).
  void invalidateEta(bookingId).catch(() => {})
  const replanned = await BookingModel.findById(bookingId)

  void notifyStage('trip_resumed', replanned ?? booking)
  void notifyStage('trip_resumed_by_staff', booking, { reason: resumeNote })
  void notifyStage('trip_resumed_staff', booking, { pausedFor })
  announcePauseChanged(bookingId)

  return replanned ?? booking
}

/* ── Continuation ─────────────────────────────────────────────────────────── */

/** "Oct 26, 2026" from YYYY-MM-DD, read as a calendar day (no timezone shift). */
function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  })
}

/** "9:00 AM" from HH:MM. */
function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** Today's date in Manila as YYYY-MM-DD. */
function todayPh(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

/**
 * While a delivery is paused, the office says when it will continue: a date for
 * the client, and that date plus a call time for the driver. Can be changed as
 * often as the plan changes; each change is announced again.
 *
 * The client is told the day. The live ETA stays blank ("Paused") until the
 * office resumes the delivery and the truck reports again.
 * pause-continuation.scheduler.ts reminds the crew before the call time and the
 * office when it passes with the delivery still paused.
 */
export async function setPauseContinuationService(
  bookingId: string,
  input: PauseContinuationInput,
  actor: DriverActor,
): Promise<BookingPause> {
  assertPauseDesk(actor, 'pause')
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  const open = await PauseModel.findOpen(bookingId)
  if (!open) throw new Error('Cannot set a continuation date: the delivery is not paused')
  if (input.date < todayPh()) throw new Error('Cannot set a continuation date in the past')
  const resumeAt = continuationAt(input.date, input.call_time)
  if (resumeAt == null) throw new Error('Cannot read the continuation date and call time')
  if (resumeAt <= Date.now()) throw new Error('Cannot set a continuation call time that has already passed')

  const saved = await PauseModel.setExpectedResume(open.pause_id, {
    expected_resume_date:      input.date,
    expected_resume_call_time: input.call_time,
    expected_resume_set_by:    actor.userId ?? null,
  })
  if (!saved) throw new Error('Cannot set a continuation date: the delivery is not paused')

  const continuationDate = dateLabel(input.date)
  const callTimeLabel    = clockLabel(input.call_time)

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'pause_continuation_set',
    description: `Booking ${bookingRef(booking)} expected to continue on ${continuationDate}, driver call time ${callTimeLabel}`,
  })

  // The client is told the day; the arrival time follows from the live ETA
  // once the truck is moving again.
  void notifyStage('pause_continuation', booking, { continuationDate })
  void notifyStage('pause_continuation_driver', booking, { continuationDate, callTimeLabel })
  announcePauseChanged(bookingId)
  // A call time set less than an hour ahead is reminded at once.
  requestPauseContinuationCheck()

  return saved
}

/* ── The driver asks to continue ──────────────────────────────────────────── */

export type ResumeRequestState = 'sent' | 'already_sent' | 'not_paused'

/** "Juan Dela Cruz", for the office's notice. */
async function userName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  try {
    const { rows } = await pool.query<{ first_name: string | null; last_name: string | null }>(
      'SELECT first_name, last_name FROM public.users WHERE user_id = $1', [userId])
    const name = [rows[0]?.first_name, rows[0]?.last_name].filter(Boolean).join(' ').trim()
    return name || null
  } catch {
    return null
  }
}

/**
 * The driver says they are ready to move again ("Ready to continue" on the
 * paused banner). It never ends the pause: the Operations Manager or the Company
 * Administrator answers by ending it (End Pause) or with "Not yet" and a reason.
 *
 * Either driver on the crew may ask (both have the same buttons since
 * 2026-11-21). One request at a time per pause: a second press, or the other
 * driver's, while one is waiting is answered 'already_sent' and tells nobody.
 *
 * Sent through the phone's offline queue, so it can arrive late. A request that
 * arrives after the pause ended, after the delivery left transit, or that was
 * made before the pause now in force began (it was for an earlier one) is
 * answered 'not_paused' with a 200: the queue drops it quietly.
 */
export async function driverRequestResumeService(
  bookingId: string,
  input: ResumeRequestInput,
  actor: DriverActor,
): Promise<{ state: ResumeRequestState; requested_at: string | null }> {
  const booking = await assertCrewDriverOnBooking(bookingId, actor)
  if (booking.status !== 'in_transit') return { state: 'not_paused', requested_at: null }

  const open = await PauseModel.findOpen(bookingId)
  if (!open) return { state: 'not_paused', requested_at: null }

  const pressedAt = confirmedAtMs(input.requested_at ?? null) ?? Date.now()
  if (pressedAt < Date.parse(open.paused_at)) return { state: 'not_paused', requested_at: null }

  if (resumeRequestOpen(open)) return { state: 'already_sent', requested_at: open.resume_requested_at }

  const requestedAt = new Date(pressedAt).toISOString()
  const note = input.note?.trim() || null
  const saved = await PauseModel.requestResume(open.pause_id, {
    resume_requested_at: requestedAt,
    resume_requested_by: actor.userId ?? null,
    resume_request_note: note,
  })
  if (!saved) {
    // The other driver asked a moment ago, or the office ended the pause.
    const now = await PauseModel.findOpen(bookingId)
    return now && resumeRequestOpen(now)
      ? { state: 'already_sent', requested_at: now.resume_requested_at }
      : { state: 'not_paused', requested_at: null }
  }

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'pause_resume_requested',
    description: `Driver asked the office to resume booking ${bookingRef(booking)}` + (note ? `: ${note}` : ''),
  })

  void notifyStage('pause_resume_requested', booking, {
    reason:     note,
    driverName: await userName(actor.userId),
    pauseLabel: PAUSE_REASON_LABEL[open.reason],
  })
  announcePauseChanged(bookingId)
  return { state: 'sent', requested_at: requestedAt }
}

/**
 * The office's "Not yet" to the driver's request: the delivery stays paused and
 * the reason goes to the crew. The driver may ask again afterwards.
 */
export async function staffDeclineResumeService(
  bookingId: string,
  note: string,
  actor: DriverActor,
): Promise<BookingPause> {
  assertPauseDesk(actor, 'resume')
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  const open = await PauseModel.findOpen(bookingId)
  if (!open) throw new Error('Cannot answer: the delivery is not paused')
  if (!resumeRequestOpen(open)) throw new Error('Cannot answer: the driver has no request waiting')

  const reason = note.trim()
  const saved = await PauseModel.declineResume(open.pause_id, {
    resume_declined_at:  new Date().toISOString(),
    resume_declined_by:  actor.userId ?? null,
    resume_decline_note: reason,
  })
  if (!saved) throw new Error('Cannot answer: the delivery is not paused')

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'pause_resume_declined',
    description: `Office answered "not yet" to the driver's request to resume booking ${bookingRef(booking)}: ${reason}`,
  })

  void notifyStage('pause_resume_declined', booking, { reason })
  announcePauseChanged(bookingId)
  return saved
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** The staff timeline: every pause, with its notes, who put it on and who ended it. */
export function listPausesService(bookingId: string): Promise<BookingPauseWithActors[]> {
  return PauseModel.findByBookingId(bookingId)
}
