import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { phDay } from '../../lib/ph-date.js'

/**
 * The driver's own on/off switch for delivery work.
 *
 * A driver account starts 'unavailable' — nobody is put in the assignable pool
 * without opting in. From the app the driver flips to 'available' when they are
 * ready to take an assignment and back to 'unavailable' when they are not.
 *
 * 'assigned' is system-owned: it is set when operations gives them a booking and
 * cleared when the delivery finishes. The driver cannot toggle out of it — they
 * have to finish (or be re-assigned off) the delivery first.
 */

export type DriverAvailability = 'available' | 'unavailable'

export interface DriverAvailabilityState {
  driver_id: string
  status:    string
  // Whether the toggle is actionable right now (false while out on a delivery).
  can_toggle: boolean
}

async function findDriverByUser(userId: string): Promise<{ driver_id: string; status: string }> {
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id, status')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('No driver profile found for this account')
  return data as { driver_id: string; status: string }
}

export async function getAvailability(userId: string): Promise<DriverAvailabilityState> {
  const driver = await findDriverByUser(userId)
  return {
    driver_id:  driver.driver_id,
    status:     driver.status,
    can_toggle: driver.status !== 'assigned',
  }
}

export async function setAvailability(
  userId: string,
  status: DriverAvailability,
): Promise<DriverAvailabilityState> {
  const driver = await findDriverByUser(userId)

  if (driver.status === 'assigned') {
    throw new Error('You are on an active delivery — finish it before changing your availability')
  }
  if (driver.status === 'on_leave' || driver.status === 'inactive') {
    throw new Error(`Your account is marked '${driver.status}' — contact the fleet manager to be reinstated`)
  }

  if (driver.status !== status) {
    const { error } = await supabase
      .from('drivers')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('driver_id', driver.driver_id)
    if (error) throw error

    logEvent({
      user_id:     userId,
      log_type:    'user_activity',
      action:      status === 'available' ? 'driver_marked_available' : 'driver_marked_unavailable',
      description: `Driver ${driver.driver_id} is now ${status} for delivery assignments`,
    })
  }

  return { driver_id: driver.driver_id, status, can_toggle: true }
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

/** Sunday, which the app's calendar draws as a rest day and cannot tick. */
const REST_WEEKDAY = 0

/**
 * Whether the driver's own calendar allows a delivery on `scheduleDate`.
 *
 * True when the driver ticked that day, and true in the two cases where the
 * calendar simply has nothing to say:
 *   - the month has no ticked days at all — an unanswered question, not a
 *     refusal, so drivers who never opened the calendar stay assignable exactly
 *     as before;
 *   - the day is a Sunday, which the app never offers as tickable. A constraint
 *     the driver had no way to express must not be read back as a refusal.
 */
export async function driverCalendarAllows(
  driverId:     string,
  scheduleDate: string | Date | null | undefined,
): Promise<boolean> {
  const day = scheduleDate instanceof Date
    ? scheduleDate.toISOString().slice(0, 10)
    : String(scheduleDate ?? '').slice(0, 10)

  // No usable date (or a booking with none) can't be judged — never block on it.
  if (!DAY_PATTERN.test(day)) return true
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === REST_WEEKDAY) return true

  const { first, nextFirst } = monthRange(day.slice(0, 7))

  const { data, error } = await supabase
    .from('driver_availability_days')
    .select('available_on')
    .eq('driver_id', driverId)
    .gte('available_on', first)
    .lt('available_on', nextFirst)

  if (error) throw error

  const marked = (data ?? []).map((row: any) => String(row.available_on).slice(0, 10))
  return marked.length === 0 || marked.includes(day)
}
