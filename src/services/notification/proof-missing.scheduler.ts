import { BookingModel } from '../../models/client/booking.model.js'
import * as ProofModel from '../../models/admin/proof-missing.model.js'
import { notifyStage } from './notification.service.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'

/**
 * Proof missing (2026-11-27): a drop-off recorded delivered without a photo
 * (the office's "Complete for the driver" when the driver's phone was stolen,
 * dead or lost) has nothing the client can see. It stays "Proof missing" until
 * staff upload a Proof of Delivery for it (the signed delivery receipt that
 * came back on paper; no review step since 2026-11-27).
 *
 * Industry: TMS and courier back offices run a daily "POD outstanding" exception
 * list until the paperwork is in (the driver's photo, when there is one, goes to
 * the customer at once, as in Onfleet). No vendor publishes an exact hour; ours
 * follows office hours.
 *
 *   each office morning (Mon–Sat, from 9:00 Manila, until 5 pm) → one notice per
 *     booking to the Operations Manager + Company Administrator, naming how
 *     many drop-offs
 *   the first one → the morning after the delivery (the paper comes back with
 *     the truck), never the same day
 *   stops → as soon as a Proof of Delivery is linked (or the driver's
 *     photo arrives late); the mark is worked out from the rows, never stored
 *
 * `booking_destinations.proof_reminded_at` makes it once per morning, also
 * after a restart or with two servers.
 */

const MINUTE_MS     = 60_000
const HOUR_MS       = 60 * MINUTE_MS
const DAY_MS        = 24 * HOUR_MS
const PH_OFFSET_MS  = 8 * HOUR_MS
const TICK_MS       = 15 * MINUTE_MS
const MORNING_HOUR  = 9
const OFFICE_CLOSES = 17

/** Midnight today in Manila (UTC+8, no daylight saving), as an instant. */
function phMidnight(now: number): number {
  return Math.floor((now + PH_OFFSET_MS) / DAY_MS) * DAY_MS - PH_OFFSET_MS
}

/** Today's 9:00 in Manila when it is an office day (Mon–Sat) and the office is open; else null. */
export function officeMorning(now: number): number | null {
  const midnight = phMidnight(now)
  const weekday  = new Date(midnight + PH_OFFSET_MS).getUTCDay() // 0 = Sunday
  if (weekday === 0) return null
  const morning = midnight + MORNING_HOUR * HOUR_MS
  if (now < morning || now >= midnight + OFFICE_CLOSES * HOUR_MS) return null
  return morning
}

/** One pass. Exported so it can be driven from a script. */
export async function runProofMissingTick(now = Date.now()): Promise<Record<string, number>> {
  const counts: Record<string, number> = { bookings: 0, reminded: 0 }
  const morning = officeMorning(now)
  if (morning == null) return counts

  const rows = await ProofModel.findProofMissingForReminder(new Date(phMidnight(now)))
  const byBooking = new Map<string, ProofModel.ProofReminderRow[]>()
  for (const r of rows) {
    const list = byBooking.get(r.booking_id)
    if (list) list.push(r)
    else byBooking.set(r.booking_id, [r])
  }
  counts.bookings = byBooking.size

  for (const [bookingId, list] of byBooking) {
    try {
      // Already reminded this morning (any of its drop-offs): wait for tomorrow.
      if (list.some((r) => r.proof_reminded_at && Date.parse(r.proof_reminded_at) >= morning)) continue
      // Claim it first, so a second server in the same tick sends nothing.
      const claimed = await ProofModel.stampProofReminded(list.map((r) => r.destination_id), new Date(now), new Date(morning))
      if (claimed === 0) continue
      const booking = await BookingModel.findById(bookingId)
      if (!booking) continue
      await notifyStage('proof_missing_staff', booking, { dropoffCount: list.length })
      counts.reminded++
    } catch (err) {
      console.error('[proof-missing] reminder failed for booking', bookingId, err)
      logSystemError('proof-missing.scheduler', 'cron_job', err, { booking_id: bookingId })
    }
  }

  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'proof-missing.scheduler',
    message:    `Proof missing tick: ${counts.reminded} booking(s) reminded of ${counts.bookings} without proof`,
    metadata:   counts,
  })
  return counts
}

let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null

function tick(): void {
  if (running) return
  running = runProofMissingTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[proof-missing] tick failed', err)
      logSystemError('proof-missing.scheduler', 'cron_job', err)
    })
    .finally(() => { running = null })
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startProofMissingScheduler(): void {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 50_000).unref?.()
}
