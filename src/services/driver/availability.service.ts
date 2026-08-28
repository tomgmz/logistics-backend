import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { phDay } from '../../lib/ph-date.js'
import { reconcileDriverStatus } from '../../lib/driver-reservation.js'

/**
 * When a driver can be given delivery work.
 *
 * The driver's calendar is the only answer to that: they tick the days they can
 * work, and operations may put them on a booking scheduled for a ticked day and
 * on no other. There is no separate on/off switch — a switch and a calendar are
 * two answers to one question, and the pair could disagree (a driver "available"
 * with no days ticked, or the reverse). The days are the opt-in.
 *
 * `drivers.status` no longer says anything about willingness. It records only the
 * states that stop work regardless of any plan:
 *   'assigned'  — out on a delivery right now. System-owned: set when operations
 *                 crews a booking, cleared when it ends. Because it overrides the
 *                 calendar, it is checked against a real delivery on every read
 *                 (see `reconcileDriverStatus`).
 *   'on_leave' /
 *   'inactive'  — stood down by the fleet manager.
 * Anything else means "not stopped" — including the legacy 'available' and
 * 'unavailable' left on rows from when the switch existed.
 */

export interface DriverAvailabilityState {
  driver_id: string
  status:    string
  // Whether the driver is out on a delivery right now. The app shows this; it is
  // not something the driver can change from their side.
  on_delivery: boolean
}

async function findDriverByUser(userId: string): Promise<{ driver_id: string; status: string }> {
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id, status')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('No driver profile found for this account')

  // 'assigned' locks this driver out of every path below, so it has to be true
  // before it is acted on. A reservation with no delivery behind it is cleared
  // here rather than trapping the driver in a state only a DBA could undo.
  const driver = data as { driver_id: string; status: string }
  return { ...driver, status: await reconcileDriverStatus(driver.driver_id, driver.status) }
}

export async function getAvailability(userId: string): Promise<DriverAvailabilityState> {
  const driver = await findDriverByUser(userId)
  return {
    driver_id:   driver.driver_id,
    status:      driver.status,
    on_delivery: driver.status === 'assigned',
  }
}

/* ── Per-day availability ─────────────────────────────────────────────────── */

/**
 * The days of one calendar month the driver has marked as workable.
 *
 * The on/off switch above is about right now; this is the driver's plan for the
 * month, ticked from the calendar behind the availability pill. Operations reads
 * it as a hard constraint when putting the driver on a booking — see
 * `driverCalendarAllows`.
 *
 * Days are Philippine calendar days (`YYYY-MM-DD`), matching the `date` columns
 * they are compared against; the server's own timezone never decides what
 * "today" means to a driver in Manila.
 */
export interface DriverAvailabilityMonth {
  driver_id: string
  // 'YYYY-MM'
  month: string
  // Marked days in the month, ascending, as 'YYYY-MM-DD'.
  days: string[]
  // Today in Philippine time, so the app locks past days without trusting the
  // device clock.
  today: string
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY_PATTERN   = /^\d{4}-\d{2}-\d{2}$/

/** Half-open [first, nextFirst) bounds of a 'YYYY-MM' month. */
function monthRange(month: string): { first: string; nextFirst: string } {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`Invalid month '${month}' — expected YYYY-MM`)
  }
  const [year, index] = month.split('-').map(Number)
  const nextYear  = index === 12 ? year + 1 : year
  const nextIndex = index === 12 ? 1 : index + 1

  return {
    first:     `${month}-01`,
    nextFirst: `${nextYear}-${String(nextIndex).padStart(2, '0')}-01`,
  }
}

export async function getAvailabilityDays(
  userId: string,
  month:  string,
): Promise<DriverAvailabilityMonth> {
  const driver = await findDriverByUser(userId)
  const { first, nextFirst } = monthRange(month)

  const { data, error } = await supabase
    .from('driver_availability_days')
    .select('available_on')
    .eq('driver_id', driver.driver_id)
    .gte('available_on', first)
    .lt('available_on', nextFirst)
    .order('available_on', { ascending: true })

  if (error) throw error

  return {
    driver_id: driver.driver_id,
    month,
    days:      (data ?? []).map((row: any) => String(row.available_on).slice(0, 10)),
    today:     phDay(),
  }
}

/**
 * Replace the driver's plan for one month with `days`.
 *
 * The whole month is sent, not a diff, because that is what the calendar screen
 * holds — but only today onward is rewritten. Days that have already passed are
 * left exactly as they were: they record what the driver committed to at the
 * time, and there is nothing useful about letting them be edited afterwards.
 */
export async function setAvailabilityDays(
  userId: string,
  month:  string,
  days:   string[],
): Promise<DriverAvailabilityMonth> {
  const driver = await findDriverByUser(userId)
  const { first, nextFirst } = monthRange(month)
  const today = phDay()

  const wanted = [...new Set(days.map((day) => String(day).slice(0, 10)))].sort()
  for (const day of wanted) {
    if (!DAY_PATTERN.test(day)) throw new Error(`Invalid day '${day}' — expected YYYY-MM-DD`)
    if (day < first || day >= nextFirst) throw new Error(`${day} is not a day in ${month}`)
  }

  const editableFrom = first > today ? first : today
  const toInsert     = wanted.filter((day) => day >= editableFrom)

  const { error: clearError } = await supabase
    .from('driver_availability_days')
    .delete()
    .eq('driver_id', driver.driver_id)
    .gte('available_on', editableFrom)
    .lt('available_on', nextFirst)
  if (clearError) throw clearError

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase
      .from('driver_availability_days')
      .insert(toInsert.map((day) => ({ driver_id: driver.driver_id, available_on: day })))
    if (insertError) throw insertError
  }

  logEvent({
    user_id:     userId,
    log_type:    'user_activity',
    action:      'driver_set_availability_days',
    description: `Driver ${driver.driver_id} marked ${toInsert.length} day(s) available in ${month}`,
  })

  return getAvailabilityDays(userId, month)
}

/**
 * Whether the driver's own calendar allows a delivery on `scheduleDate`.
 *
 * The calendar IS the driver's opt-in: a ticked day is the whole of what they
 * agreed to work, so a day they did not tick is a no. A driver who never opened
 * the calendar has therefore agreed to nothing and is assignable on no day —
 * this used to read an empty month as "no answer" and let them through, which
 * meant the plan they filled in only ever narrowed a pool they were already in.
 * It is now the pool itself.
 *
 * Sundays are the one day the calendar cannot express, so no driver can tick one
 * — which is why a Sunday never becomes a booking in the first place (see
 * `validateScheduleDate`). Nothing here needs to special-case it.
 */
export async function driverCalendarAllows(
  driverId:     string,
  scheduleDate: string | Date | null | undefined,
): Promise<boolean> {
  const day = scheduleDate instanceof Date
    ? scheduleDate.toISOString().slice(0, 10)
    : String(scheduleDate ?? '').slice(0, 10)

  // A booking with no usable date can't be judged against a calendar at all —
  // there is no day to look up, so this gate has nothing to say and abstains.
  if (!DAY_PATTERN.test(day)) return true

  const { data, error } = await supabase
    .from('driver_availability_days')
    .select('available_on')
    .eq('driver_id', driverId)
    .eq('available_on', day)
    .maybeSingle()

  if (error) throw error
  return data != null
}

/**
 * The drivers who ticked `day`, as a set of driver ids.
 *
 * The same question as `driverCalendarAllows` asked for a whole roster at once,
 * so building the assignment dropdown is one query rather than one per driver.
 */
export async function driversAvailableOn(day: string): Promise<Set<string>> {
  if (!DAY_PATTERN.test(day)) throw new Error(`Invalid day '${day}' — expected YYYY-MM-DD`)

  const { data, error } = await supabase
    .from('driver_availability_days')
    .select('driver_id')
    .eq('available_on', day)

  if (error) throw error
  return new Set((data ?? []).map((row: any) => String(row.driver_id)))
}
