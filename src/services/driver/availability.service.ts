import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { phDay } from '../../lib/ph-date.js'
import { reconcileDriverStatus } from '../../lib/driver-reservation.js'
import { broadcast } from '../../lib/realtime.js'

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
  // Whether that delivery has actually left (booking 'in_transit'). Until then
  // the driver is only crewed onto it, and the app says "Assigned" rather than
  // "On delivery".
  in_transit: boolean
  // A vendor's driver: crewed booking by booking, never in the company pool, so
  // there is no schedule to keep and the app shows no calendar at all.
  vendor: boolean
}

/** Thrown for a vendor driver reaching the work-schedule calendar. */
export const VENDOR_NO_SCHEDULE = 'Vendor drivers do not set a work schedule'

/** Whether the driver — main or second — is on a booking that is under way. */
async function isInTransit(driverId: string): Promise<boolean> {
  // On the road also covers "done delivering, driving back to the parking":
  // the driver stays held until the return is confirmed, and the app's pill
  // should read "On delivery" then, not "Assigned".
  const { data, error } = await supabase
    .from('deliveries')
    .select('delivery_id, bookings!inner ( status, fleet_return_at )')
    .or(`driver_id.eq.${driverId},second_driver_id.eq.${driverId}`)
    .in('bookings.status', ['in_transit', 'delivered', 'completed', 'failed'])
  if (error) throw error
  return (data ?? []).some((row: any) => {
    const b = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings
    return b?.status === 'in_transit' || !b?.fleet_return_at
  })
}

async function findDriverByUser(userId: string): Promise<{ driver_id: string; status: string; is_external: boolean }> {
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id, status, is_external')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('No driver profile found for this account')

  // 'assigned' locks this driver out of every path below, so it has to be true
  // before it is acted on. A reservation with no delivery behind it is cleared
  // here rather than trapping the driver in a state only a DBA could undo.
  const driver = data as { driver_id: string; status: string; is_external: boolean | null }
  return {
    ...driver,
    is_external: driver.is_external === true,
    status: await reconcileDriverStatus(driver.driver_id, driver.status),
  }
}

export async function getAvailability(userId: string): Promise<DriverAvailabilityState> {
  const driver     = await findDriverByUser(userId)
  const onDelivery = driver.status === 'assigned'
  return {
    driver_id:   driver.driver_id,
    status:      driver.status,
    on_delivery: onDelivery,
    in_transit:  onDelivery && await isInTransit(driver.driver_id),
    vendor:      driver.is_external,
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
  // The days of this month the driver may change right now (see
  // `editableDays`). Every other day is shown but cannot be ticked or unticked.
  editable: string[]
  // True when this week (Sunday to Saturday) already has a ticked day, so the
  // whole week is fixed.
  week_locked: boolean
  // Only on a read of the current month: next month, when its first week is open
  // (from the second-to-last week of this month), so the app can show it on the
  // same calendar without a second round trip. null otherwise.
  next: DriverAvailabilityMonth | null
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY_PATTERN   = /^\d{4}-\d{2}-\d{2}$/

/* ── What the driver may change, and when ───────────────────────────────────
 *
 * Weeks run Sunday to Saturday, the rows of the calendar the driver sees.
 *
 *   1. This month, today onward, can be set.
 *   2. Next month opens one week early: from the second-to-last week (row) of
 *      this month, the driver can also set next month's first week (the days of
 *      next month in the row that holds its 1st). The rest of next month opens
 *      on the 1st. Operations plans a week ahead, so the driver's answer for the
 *      start of next month has to be in before that week arrives.
 *   3. Once this week has a ticked day, this week is fixed: nothing in it can be
 *      added or removed. Operations assigns against those days, so a driver
 *      cannot pull out of a day mid-week from the app (they call the Operations
 *      Manager instead). A driver with nothing ticked this week can still add a
 *      day; that first save then fixes the week.
 *
 * Industry practice: shift schedulers (When I Work, Deputy, Homebase) lock
 * availability changes inside a notice window and only open the schedule a set
 * time ahead; this is the same idea with a one-week window.
 */

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The Sunday that starts `day`'s calendar row. */
function weekStart(day: string): string {
  return addDays(day, -new Date(`${day}T00:00:00Z`).getUTCDay())
}

export interface AvailabilityWindow {
  today:          string
  currentMonth:   string
  nextMonth:      string
  // This week, Sunday to Saturday (may run into next month).
  weekFrom:       string
  weekTo:         string
  // The day next month's first week opens: the Sunday of this month's
  // second-to-last row.
  nextOpensOn:    string
  nextMonthOpen:  boolean
  // Last day of next month's first week (the Saturday of the row with its 1st).
  nextFirstWeekTo: string
}

export function availabilityWindow(today: string = phDay()): AvailabilityWindow {
  const currentMonth = today.slice(0, 7)
  const { nextFirst } = monthRange(currentMonth)
  const lastDay      = addDays(nextFirst, -1)
  const nextOpensOn  = addDays(weekStart(lastDay), -7)
  const weekFrom     = weekStart(today)
  return {
    today,
    currentMonth,
    nextMonth:       nextFirst.slice(0, 7),
    weekFrom,
    weekTo:          addDays(weekFrom, 6),
    nextOpensOn,
    nextMonthOpen:   today >= nextOpensOn,
    nextFirstWeekTo: addDays(weekStart(nextFirst), 6),
  }
}

/** The days of `month` the driver may change now, ascending. */
export function editableDays(month: string, w: AvailabilityWindow, weekLocked: boolean): string[] {
  const { first, nextFirst } = monthRange(month)
  let to: string
  if (month === w.currentMonth)                  to = addDays(nextFirst, -1)
  else if (month === w.nextMonth && w.nextMonthOpen) to = w.nextFirstWeekTo
  else return []

  const out: string[] = []
  for (let day = first > w.today ? first : w.today; day <= to; day = addDays(day, 1)) {
    if (weekLocked && day >= w.weekFrom && day <= w.weekTo) continue
    out.push(day)
  }
  return out
}

/** Whether this week (Sunday to Saturday) already has a ticked day. */
async function weekIsLocked(driverId: string, w: AvailabilityWindow): Promise<boolean> {
  const { count, error } = await supabase
    .from('driver_availability_days')
    .select('available_on', { count: 'exact', head: true })
    .eq('driver_id', driverId)
    .gte('available_on', w.weekFrom)
    .lte('available_on', w.weekTo)
  if (error) throw error
  return (count ?? 0) > 0
}

function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
}

function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** Why `day` cannot be changed now, in the driver's words. */
function lockedReason(day: string, month: string, w: AvailabilityWindow, weekLocked: boolean): string {
  if (weekLocked && day >= w.weekFrom && day <= w.weekTo) {
    return 'You already have days set this week, so this week can no longer be changed. '
      + 'Call the Operations Manager if you cannot work a day you set.'
  }
  if (month === w.nextMonth) {
    return w.nextMonthOpen
      ? `Only the first week of ${monthName(month)} can be set now. The rest opens on ${longDay(`${month}-01`)}.`
      : `You can set the first week of ${monthName(month)} from ${longDay(w.nextOpensOn)}.`
  }
  return 'You can only set days for this month and, near the end of the month, the first week of next month.'
}

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

async function savedDays(driverId: string, month: string): Promise<string[]> {
  const { first, nextFirst } = monthRange(month)
  const { data, error } = await supabase
    .from('driver_availability_days')
    .select('available_on')
    .eq('driver_id', driverId)
    .gte('available_on', first)
    .lt('available_on', nextFirst)
    .order('available_on', { ascending: true })

  if (error) throw error
  return (data ?? []).map((row: any) => String(row.available_on).slice(0, 10))
}

async function readMonth(
  driverId: string,
  month:    string,
  w:        AvailabilityWindow,
  locked:   boolean,
): Promise<DriverAvailabilityMonth> {
  return {
    driver_id:   driverId,
    month,
    days:        await savedDays(driverId, month),
    today:       w.today,
    editable:    editableDays(month, w, locked),
    week_locked: locked,
    next:        null,
  }
}

export async function getAvailabilityDays(
  userId: string,
  month:  string,
): Promise<DriverAvailabilityMonth> {
  const driver = await findDriverByUser(userId)
  if (driver.is_external) throw new Error(VENDOR_NO_SCHEDULE)
  monthRange(month)

  const w      = availabilityWindow()
  const locked = await weekIsLocked(driver.driver_id, w)
  const [current, next] = await Promise.all([
    readMonth(driver.driver_id, month, w, locked),
    month === w.currentMonth && w.nextMonthOpen
      ? readMonth(driver.driver_id, w.nextMonth, w, locked)
      : Promise.resolve(null),
  ])
  return { ...current, next }
}

/**
 * Replace the driver's plan for one month with `days`.
 *
 * The whole month is sent, not a diff, because that is what the calendar screen
 * holds — but only the days the driver may change now (`editableDays`) are
 * rewritten. Days already past are left as they were and silently ignored (a
 * stale screen sends them back unchanged). A change to any other locked day — a
 * fixed week, next month before it opens — is refused with the reason, so an
 * older app that doesn't grey those days out can't change them either.
 */
export async function setAvailabilityDays(
  userId: string,
  month:  string,
  days:   string[],
): Promise<DriverAvailabilityMonth> {
  const driver = await findDriverByUser(userId)
  if (driver.is_external) throw new Error(VENDOR_NO_SCHEDULE)
  const { first, nextFirst } = monthRange(month)

  const wanted = [...new Set((Array.isArray(days) ? days : []).map((day) => String(day).slice(0, 10)))].sort()
  for (const day of wanted) {
    if (!DAY_PATTERN.test(day)) throw new Error(`Invalid day '${day}' — expected YYYY-MM-DD`)
    if (day < first || day >= nextFirst) throw new Error(`${day} is not a day in ${month}`)
  }

  const w        = availabilityWindow()
  const locked   = await weekIsLocked(driver.driver_id, w)
  const editable = new Set(editableDays(month, w, locked))
  const saved    = new Set(await savedDays(driver.driver_id, month))
  const wantedSet = new Set(wanted)

  for (const day of new Set([...wanted, ...saved])) {
    if (editable.has(day) || day < w.today) continue
    if (wantedSet.has(day) !== saved.has(day)) throw new Error(lockedReason(day, month, w, locked))
  }

  const toInsert = wanted.filter((day) => editable.has(day))

  if (editable.size > 0) {
    const { error: clearError } = await supabase
      .from('driver_availability_days')
      .delete()
      .eq('driver_id', driver.driver_id)
      .in('available_on', [...editable])
    if (clearError) throw clearError
  }

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase
      .from('driver_availability_days')
      .insert(toInsert.map((day) => ({ driver_id: driver.driver_id, available_on: day })))
    if (insertError) throw insertError
  }

  logEvent({
    user_id:     userId,
    log_type:    'driver_activity',
    action:      'driver_set_availability_days',
    description: `Driver ${driver.driver_id} marked ${toInsert.length} day(s) available in ${month}`,
  })

  // The assignable pool for a booking is exactly the set of drivers who ticked
  // its day, so a driver confirming their calendar changes what operations may
  // pick right now. Pushed rather than polled, and pushed as a signal rather
  // than as data: the browser re-asks the API (which also applies the vehicle
  // and status gates) instead of trying to recompute the pool from this payload.
  //
  // `month` is on it because a write only ever rewrites one month, so a booking
  // scheduled in another month cannot be affected and need not refetch.
  void broadcast('fleet:availability', 'driver_availability_changed', {
    driver_id: driver.driver_id,
    month,
    days:      toInsert,
  }).catch((e) => console.warn('[availability] broadcast failed:', e?.message))

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
 * Sundays are ordinary days here: transit runs seven days a week, so a driver
 * ticks a Sunday like any other day.
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
