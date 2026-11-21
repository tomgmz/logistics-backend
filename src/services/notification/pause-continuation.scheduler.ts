import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'
import { continuationAt } from '../maps/planned-eta.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { formatDuration } from '../../lib/duration.js'
import { PAUSE_REASON_LABEL, resumeRequestOpen, type PauseReason } from '../../types/client/pause.types.js'

/**
 * Watches paused deliveries. Only the Operations Manager and the Company
 * Administrator can end a pause, and while it lasts the driver's stop
 * confirmations are held, so a forgotten pause leaves the driver waiting. The
 * office is chased until it acts — the way fleet systems escalate an open
 * exception rather than ending it on their own (user 2026-11-21, option A):
 *
 *   With a continuation date (the day and driver call time it moves again —
 *   see setPauseContinuationService):
 *   * an hour before that call time, the crew is reminded (a typhoon pause can
 *     last days; nobody should have to remember the date from the first notice);
 *   * once the call time is OVERDUE_MS past and the delivery is still paused,
 *     the Operations Manager and Company Administrator are told to resume it or
 *     set a new date, and told again every REPEAT_MS until they do;
 *   * GM_OVERDUE_MS past the call time, the General Manager is told once.
 *
 *   With no continuation date:
 *   * NO_DATE_FIRST_MS after the pause started, the office is reminded to resume
 *     it or set a date, then again every morning at MORNING_HOUR (Manila) while
 *     it is still open with no date;
 *   * GM_NO_DATE_MS after the pause started, the General Manager is told once.
 *
 *   The driver pressed "Ready to continue" (pause.service driverRequestResumeService;
 *   the office was told at once):
 *   * while nobody has answered (ended the pause or said "Not yet"), the office
 *     is reminded every REQUEST_REPEAT_MS;
 *   * GM_REQUEST_MS after the request, the General Manager is told once.
 *
 * Stamps: `continuation_reminded_for` / `continuation_overdue_for` /
 * `gm_escalated_for` hold the instant a notice went out for (the continuation
 * instant, or paused_at with no date), so changing the date or call time re-arms
 * them. `office_reminded_at` is when the office was last reminded; the repeats
 * are timed from it. Each stamp is written after its fan-out resolves.
 *
 * Same in-process shape as driver-call.scheduler.ts.
 */

const MINUTE_MS        = 60 * 1000
const HOUR_MS          = 60 * MINUTE_MS
const LEAD_MS          = 60 * MINUTE_MS
const OVERDUE_MS       = 15 * MINUTE_MS
const REPEAT_MS        = 30 * MINUTE_MS
const GM_OVERDUE_MS    = 2 * HOUR_MS
const NO_DATE_FIRST_MS = 2 * HOUR_MS
const GM_NO_DATE_MS    = 24 * HOUR_MS
const REQUEST_REPEAT_MS = 15 * MINUTE_MS
const GM_REQUEST_MS    = 1 * HOUR_MS
const MORNING_HOUR     = 7
const TICK_MS          = 5 * MINUTE_MS

export interface OpenPauseRow {
  pause_id:                  string
  booking_id:                string
  reason:                    PauseReason
  paused_at:                 string
  expected_resume_date:      string | null
  expected_resume_call_time: string | null
  continuation_reminded_for: string | null
  continuation_overdue_for:  string | null
  office_reminded_at:        string | null
  gm_escalated_for:          string | null
  resume_requested_at:        string | null
  resume_declined_at:         string | null
  resume_request_reminded_at: string | null
  resume_request_gm_for:      string | null
}

type StampField =
  | 'continuation_reminded_for'
  | 'continuation_overdue_for'
  | 'office_reminded_at'
  | 'gm_escalated_for'
  | 'resume_request_reminded_at'
  | 'resume_request_gm_for'

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

/** The latest MORNING_HOUR:00 in Manila (UTC+8, no daylight saving) at or before `now`. */
export function lastMorning(now: number): number {
  const PH_OFFSET  = 8 * HOUR_MS
  const DAY_MS     = 24 * HOUR_MS
  const phMidnight = Math.floor((now + PH_OFFSET) / DAY_MS) * DAY_MS - PH_OFFSET
  const today      = phMidnight + MORNING_HOUR * HOUR_MS
  return today <= now ? today : today - DAY_MS
}

/** Every pause still in force — a handful at most. */
async function findOpenPauses(): Promise<OpenPauseRow[]> {
  const { data, error } = await supabase
    .from('booking_pauses')
    .select(
      'pause_id, booking_id, reason, paused_at, expected_resume_date, expected_resume_call_time, ' +
      'continuation_reminded_for, continuation_overdue_for, office_reminded_at, gm_escalated_for, ' +
      'resume_requested_at, resume_declined_at, resume_request_reminded_at, resume_request_gm_for',
    )
    .is('resumed_at', null)
  if (error) throw error
  return (data ?? []) as unknown as OpenPauseRow[]
}

async function stamp(pauseId: string, fields: Partial<Record<StampField, number>>): Promise<void> {
  const update: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) update[k] = new Date(v as number).toISOString()
  const { error } = await supabase
    .from('booking_pauses')
    .update(update)
    .eq('pause_id', pauseId)
  if (error) throw error
}

export interface PausePlan {
  /** The crew's reminder an hour before the continuation call time. */
  driverDue:    boolean
  /** The call time passed with the delivery still paused: first notice or a repeat. */
  officeLate:   boolean
  /** No continuation date: the 2-hour notice or a morning one. */
  officeNoDate: boolean
  /** The one-off notice to the General Manager. */
  gm:           boolean
  /** The continuation instant, when one is set. */
  at:           number | null
  /** The instant the GM stamp is keyed on: the continuation, else paused_at. */
  key:          number
  /** The driver's "Ready to continue" is still unanswered: remind the office. */
  requestWaiting: boolean
  /** ... for an hour: tell the General Manager once. */
  requestGm:      boolean
  /** That request's instant, when one is open. */
  requestedAt:    number | null
}

/** The driver's open request, and what it is owed now. */
function planRequest(row: OpenPauseRow, now: number): Pick<PausePlan, 'requestWaiting' | 'requestGm' | 'requestedAt'> {
  const open = resumeRequestOpen({ resumed_at: null, resume_requested_at: row.resume_requested_at, resume_declined_at: row.resume_declined_at })
  if (!open || !row.resume_requested_at) return { requestWaiting: false, requestGm: false, requestedAt: null }
  const asked = Date.parse(row.resume_requested_at)
  const last  = row.resume_request_reminded_at ? Date.parse(row.resume_request_reminded_at) : asked
  return {
    requestWaiting: now - last >= REQUEST_REPEAT_MS,
    requestGm:      now - asked >= GM_REQUEST_MS && !sameInstant(row.resume_request_gm_for, asked),
    requestedAt:    asked,
  }
}

/** What one open pause is owed right now. Pure, so it can be tested on its own. */
export function planPause(row: OpenPauseRow, now: number): PausePlan {
  const pausedAt   = Date.parse(row.paused_at)
  const lastOffice = row.office_reminded_at ? Date.parse(row.office_reminded_at) : null
  const at = row.expected_resume_date && row.expected_resume_call_time
    ? continuationAt(row.expected_resume_date, row.expected_resume_call_time)
    : null

  if (at != null) {
    const left      = at - now
    const firstLate = -left >= OVERDUE_MS && !sameInstant(row.continuation_overdue_for, at)
    const repeat    = !firstLate && sameInstant(row.continuation_overdue_for, at) &&
      (lastOffice == null || now - lastOffice >= REPEAT_MS)
    return {
      driverDue:    left > 0 && left <= LEAD_MS && !sameInstant(row.continuation_reminded_for, at),
      officeLate:   firstLate || repeat,
      officeNoDate: false,
      gm:           -left >= GM_OVERDUE_MS && !sameInstant(row.gm_escalated_for, at),
      at,
      key:          at,
      ...planRequest(row, now),
    }
  }

  const pausedFor = now - pausedAt
  return {
    driverDue:    false,
    officeLate:   false,
    officeNoDate: pausedFor >= NO_DATE_FIRST_MS && (lastOffice == null || lastOffice < lastMorning(now)),
    gm:           pausedFor >= GM_NO_DATE_MS && !sameInstant(row.gm_escalated_for, pausedAt),
    at:           null,
    key:          pausedAt,
    ...planRequest(row, now),
  }
}

export interface PauseTickResult {
  reminded:  number
  overdue:   number
  noDate:    number
  escalated: number
  requests:  number
}

/** One pass. Exported so it can be driven from a script. */
export async function runPauseContinuationTick(now = Date.now()): Promise<PauseTickResult> {
  const rows = await findOpenPauses()
  const result: PauseTickResult = { reminded: 0, overdue: 0, noDate: 0, escalated: 0, requests: 0 }

  for (const row of rows) {
    const plan = planPause(row, now)
    if (!plan.driverDue && !plan.officeLate && !plan.officeNoDate && !plan.gm &&
        !plan.requestWaiting && !plan.requestGm) continue

    try {
      const booking = await BookingModel.findById(row.booking_id)
      // Resumed or ended since the read (the office can still finish a paused
      // delivery for the driver): nothing to chase.
      if (!booking || booking.status !== 'in_transit' ||
          !(booking as { paused_at?: string | null }).paused_at) continue

      const at         = plan.at
      const pausedFor  = formatDuration((now - Date.parse(row.paused_at)) / MINUTE_MS)
      const pauseLabel = PAUSE_REASON_LABEL[row.reason] ?? 'Paused'

      if (plan.driverDue && at != null) {
        await notifyStage('pause_continuation_due', booking, {
          callTimeLabel: formatClock(at),
          minutesLeft:   Math.max(1, Math.round((at - now) / MINUTE_MS)),
        })
        await stamp(row.pause_id, { continuation_reminded_for: at })
        result.reminded++
      }
      if (plan.officeLate && at != null) {
        await notifyStage('pause_continuation_overdue', booking, {
          callTimeLabel:    formatClock(at),
          continuationDate: formatDay(at),
          minutesLeft:      Math.round((now - at) / MINUTE_MS),
        })
        await stamp(row.pause_id, { continuation_overdue_for: at, office_reminded_at: now })
        result.overdue++
      }
      if (plan.officeNoDate) {
        await notifyStage('pause_no_date', booking, { pauseLabel, pausedFor })
        await stamp(row.pause_id, { office_reminded_at: now })
        result.noDate++
      }
      if (plan.gm) {
        await notifyStage('pause_unresolved_gm', booking, at != null
          ? { callTimeLabel: formatClock(at), continuationDate: formatDay(at), minutesLeft: Math.round((now - at) / MINUTE_MS) }
          : { pauseLabel, pausedFor })
        await stamp(row.pause_id, { gm_escalated_for: plan.key })
        result.escalated++
      }
      if (plan.requestWaiting && plan.requestedAt != null) {
        await notifyStage('pause_resume_request_waiting', booking, {
          minutesLeft: Math.round((now - plan.requestedAt) / MINUTE_MS),
        })
        await stamp(row.pause_id, { resume_request_reminded_at: now })
        result.requests++
      }
      if (plan.requestGm && plan.requestedAt != null) {
        await notifyStage('pause_unresolved_gm', booking, {
          driverAsked: true,
          minutesLeft: Math.round((now - plan.requestedAt) / MINUTE_MS),
        })
        await stamp(row.pause_id, { resume_request_gm_for: plan.requestedAt })
        result.escalated++
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
    message:
      `Pause tick: ${result.reminded} driver reminder(s), ${result.overdue} overdue, ` +
      `${result.noDate} with no date, ${result.requests} driver request reminder(s), ${result.escalated} to the General Manager`,
    metadata:   { open_pauses: rows.length, ...result },
  })

  return result
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
