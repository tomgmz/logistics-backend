import { supabase } from '../../lib/supabase.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { notifyStage } from './notification.service.js'

/**
 * Nudges the fleet manager to re-run the BLOWBAGETS check on a booking's vehicle
 * before it rolls out.
 *
 * A vehicle inspection holds until it is replaced, which is fine for the
 * selection list but not good enough on dispatch day — a truck cleared three
 * weeks ago should be looked at again. So every crewed booking gets two nudges:
 *
 *   day_before — ~24h before the call time, while there is still time to fix a
 *                fault. A booking made today for tomorrow is already inside that
 *                window, so its nudge goes out on the next tick.
 *   day_of     — ~3h before the call time, a last look before it leaves.
 *
 * Each nudge is stamped on the booking (`fleet_recheck_day_before_at` /
 * `fleet_recheck_day_of_at`) so it is sent exactly once, including across
 * restarts. Sends are idempotent rather than exact: the tick interval decides how
 * closely the actual send tracks the target moment.
 */

// Operations run on Philippine time, which has no DST — a fixed offset is exact.
const PH_UTC_OFFSET_HOURS = 8

const HOUR_MS       = 60 * 60 * 1000
const DAY_BEFORE_MS = 24 * HOUR_MS
const DAY_OF_MS     = 3  * HOUR_MS
const TICK_MS       = 15 * 60 * 1000

interface DueBookingRow {
  booking_id:                  string
  schedule_date:               string
  call_time:                   string
  fleet_recheck_day_before_at: string | null
  fleet_recheck_day_of_at:     string | null
}

/** The moment a booking is due to roll out, as a UTC instant. */
function dispatchAt(scheduleDate: string, callTime: string): Date | null {
  const time = (callTime ?? '').slice(0, 8).padEnd(8, '0').replace(/^(\d{2}:\d{2})$/, '$1:00')
  const iso  = `${scheduleDate}T${time}+0${PH_UTC_OFFSET_HOURS}:00`
  const at   = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * Bookings that are crewed and dispatching soon. Kept to a narrow date window so
 * the tick stays cheap regardless of how much history the table holds.
 */
async function findCandidates(): Promise<DueBookingRow[]> {
  const today    = new Date()
  const from     = new Date(today.getTime() - DAY_BEFORE_MS)
  const to       = new Date(today.getTime() + 2 * DAY_BEFORE_MS)
  const dateOnly = (d: Date) => d.toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('bookings')
    .select('booking_id, schedule_date, call_time, fleet_recheck_day_before_at, fleet_recheck_day_of_at')
    .eq('status', 'assigned')
    .gte('schedule_date', dateOnly(from))
    .lte('schedule_date', dateOnly(to))

  if (error) throw error
  return (data ?? []) as DueBookingRow[]
}

/** Plate + model of the vehicle on this booking, for the reminder copy. */
async function vehicleLabelFor(bookingId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('deliveries')
    .select('vendor_vehicle_plate, trucks ( plate_number, truck_models ( name, vehicle_type ) )')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  const truck = (data as any).trucks
  if (truck?.plate_number) {
    const name = truck.truck_models?.name ?? truck.truck_models?.vehicle_type ?? null
    return name ? `${truck.plate_number} · ${name}` : String(truck.plate_number)
  }
  return (data as any).vendor_vehicle_plate ?? null
}

async function sendReminder(
  bookingId: string,
  window: 'day_before' | 'day_of',
): Promise<void> {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) return

  const vehicleLabel = await vehicleLabelFor(bookingId)
  await notifyStage('fleet_recheck', booking, { window, vehicleLabel })
  // Stamped only after the fan-out resolves, so a failed send is retried next tick.
  await BookingModel.markFleetRecheckSent(bookingId, window)
}

/** One pass over the due bookings. Exported so it can be driven from a script. */
export async function runFleetRecheckTick(now = new Date()): Promise<number> {
  let sent = 0
  const candidates = await findCandidates()

  for (const row of candidates) {
    const at = dispatchAt(row.schedule_date, row.call_time)
    if (!at) continue

    const untilDispatch = at.getTime() - now.getTime()
    // Past its dispatch moment by more than a day: no point nudging any more.
    if (untilDispatch < -DAY_BEFORE_MS) continue

    try {
      if (!row.fleet_recheck_day_before_at && untilDispatch <= DAY_BEFORE_MS) {
        await sendReminder(row.booking_id, 'day_before')
        sent++
      }
      if (!row.fleet_recheck_day_of_at && untilDispatch <= DAY_OF_MS) {
        await sendReminder(row.booking_id, 'day_of')
        sent++
      }
    } catch (err) {
      console.error('[fleet-recheck] reminder failed for booking', row.booking_id, err)
    }
  }

  return sent
}

let timer: NodeJS.Timeout | null = null

/**
 * Start the recurring tick. Safe to call once at boot; a second call is ignored.
 * With more than one server process this fires per process, but the
 * `fleet_recheck_*` stamps keep the notification itself single-shot.
 */
export function startFleetRecheckScheduler(): void {
  if (timer) return

  const tick = () => {
    runFleetRecheckTick().catch((err) => console.error('[fleet-recheck] tick failed', err))
  }

  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  // Run once at boot so reminders that came due while the server was down go out
  // immediately rather than waiting a full interval.
  setTimeout(tick, 10_000).unref?.()
}
