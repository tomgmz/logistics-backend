import PauseModel from '../../models/client/pause.model.js'
import TripModel from '../../models/client/trip.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { broadcast } from '../../lib/realtime.js'
import { notifyStage } from '../notification/notification.service.js'
import { createReportService } from '../driver/report.service.js'
import { refreshPlannedEta } from '../maps/planned-eta.service.js'
import { invalidateEta } from '../maps/eta.service.js'
import type { DriverActor } from './booking.service.js'
import {
  PAUSE_REASON_LABEL,
  type BookingPause,
  type BookingPauseWithActors,
  type PauseTripInput,
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

  const label = PAUSE_REASON_LABEL[input.reason]

  logEvent({
    user_id:     actor.userId,
    log_type:    'booking',
    action:      'staff_trip_paused',
    description: `Booking ${bookingRef(booking)} paused by the office — ${label}: ${note}`,
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
      (resumeNote ? `: ${resumeNote}` : ''),
  })

  // The pause moved every arrival after it. Re-plan (pause time is added in
  // refreshPlannedEta) and let the next ping buy a fresh live ETA.
  const before = (booking as { estimated_delivery?: string | null }).estimated_delivery ?? null
  await refreshPlannedEta(bookingId)
  void invalidateEta(bookingId).catch(() => {})
  const replanned = await BookingModel.findById(bookingId)
  const after = (replanned as { estimated_delivery?: string | null } | null)?.estimated_delivery ?? null
  const shiftMin = before && after ? (Date.parse(after) - Date.parse(before)) / 60_000 : 0

  void notifyStage('trip_resumed', replanned ?? booking, {
    newArrival: after && shiftMin >= NOTIFY_SHIFT_MIN ? arrivalWindowPh(after) : undefined,
  })
  void notifyStage('trip_resumed_by_staff', booking, { reason: resumeNote })
  void notifyStage('trip_resumed_staff', booking, { pausedFor })
  announcePauseChanged(bookingId)

  return replanned ?? booking
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** The staff timeline: every pause, with its notes, who put it on and who ended it. */
export function listPausesService(bookingId: string): Promise<BookingPauseWithActors[]> {
  return PauseModel.findByBookingId(bookingId)
}
