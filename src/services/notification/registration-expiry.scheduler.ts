import * as notificationModel from '../../models/notification/notification.model.js'
import * as reminderModel from '../../models/admin/registration-reminder.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { phDay } from '../../lib/ph-date.js'
import { addOneMonth, daysBetween } from '../../lib/registration-expiry.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { NotificationRow } from '../../types/notification.types.js'

/**
 * Tells the company, one month ahead, that a fleet vehicle's registration is
 * about to expire — so it is renewed before the vehicle has to stay in the yard
 * (an expired registration blocks assignment, see assertRegistrationValid).
 * Every active Fleet Manager and Company Administrator gets it in the app (row +
 * realtime + push). No email (the user's call, 2026-11-01): the system
 * notification is the one channel.
 *
 * Once per expiry date, per vehicle: trucks.registration_reminder_notified_for
 * holds the expiry date the reminder was sent for (_emailed_for is no longer
 * written; the column is kept).
 * A renewal changes registration_expiry, the stamps stop matching, and the new
 * date gets its own reminder a month out.
 *
 * "One month" is a calendar month in Philippine time, the same window as the
 * driver's license reminder. A date already inside the window when it is entered
 * is reminded on the next pass; one already past is not "expiring soon" and is
 * left to the Upkeep tab and the assignment block.
 */

const TICK_MS = 60 * 60 * 1000

const TYPE = 'vehicle.registration_expiring' as const

/** "November 4, 2026" — a plain date, so it is formatted as UTC to avoid a day shift. */
function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: 'UTC' })
    .format(new Date(`${day}T00:00:00Z`))
}

/** Vehicle Management's Maintenance tab in the recipient's own portal. */
function upkeepUrlForRole(role: string): string {
  return role === 'fleet_manager'
    ? '/fleet_admin/vehicle-management?tab=maintenance'
    : '/admin/vehicle-management?tab=maintenance'
}

function inDaysPhrase(days: number): string {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

async function notifyInApp(
  c: reminderModel.RegistrationReminderCandidate,
  recipients: reminderModel.RegistrationReminderRecipient[],
  expiresOn: string,
  daysLeft: number,
) {
  const title = `${c.plate_number} registration expires soon`
  const body  =
    `The registration of ${c.plate_number} expires on ${expiresOn} (${inDaysPhrase(daysLeft)}). ` +
    'Renew it and enter the new expiry date in Vehicle Management — once it expires the vehicle cannot be assigned to a booking.'
  const data  = { type: TYPE, truck_id: c.truck_id, plate_number: c.plate_number, registration_expiry: c.registration_expiry }

  const rows = await notificationModel.insertMany(recipients.map((r) => ({
    user_id: r.user_id, type: TYPE, title, body, booking_id: null,
    data:    { ...data, action_url: upkeepUrlForRole(r.role) },
  })))

  // Realtime and push are best effort; the stored rows are the notification.
  for (const row of rows ?? []) {
    void broadcast(`notifications:user:${row.user_id}`, 'new_notification', row as NotificationRow)
      .catch(() => {})
  }
  // Grouped by link so each person's push opens their own portal.
  for (const role of new Set(recipients.map((r) => r.role))) {
    const ids = recipients.filter((r) => r.role === role).map((r) => r.user_id)
    void push.sendToUsers(ids, { title, body, data: { ...data, action_url: upkeepUrlForRole(role) } })
  }
}

/** One pass. Exported so it can be driven from a script. */
export async function runRegistrationExpiryTick(now = new Date()): Promise<{ notified: number }> {
  const today  = phDay(now)
  const cutoff = addOneMonth(today)
  const rows   = await reminderModel.findExpiringBetween(today, cutoff)

  let notified = 0

  // Nobody to tell (no Fleet Manager or Company Administrator yet): leave the
  // stamps alone so the reminder goes out once someone is.
  const recipients = rows.length > 0 ? await reminderModel.findRecipients() : []

  if (recipients.length > 0) {
    for (const c of rows) {
      const expiresOn = formatDay(c.registration_expiry)
      const daysLeft  = daysBetween(today, c.registration_expiry)

      if (c.registration_reminder_notified_for !== c.registration_expiry) {
        try {
          await notifyInApp(c, recipients, expiresOn, daysLeft)
          await reminderModel.markReminded(c.truck_id, 'notified', c.registration_expiry)
          notified++
        } catch (err) {
          console.error('[registration-expiry] in-app reminder failed for truck', c.truck_id, err)
          logSystemError('registration-expiry.scheduler', 'cron_job', err, { truck_id: c.truck_id, channel: 'in_app' })
        }
      }
    }
  }

  // Heartbeat on success too, so the IT Admin dashboard can tell a quiet day
  // from a stopped scheduler.
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'registration-expiry.scheduler',
    message:    `Registration expiry tick: ${notified} in-app reminder(s) sent`,
    metadata:   { candidates: rows.length, recipients: recipients.length, notified, window_end: cutoff },
  })

  return { notified }
}

let timer: NodeJS.Timeout | null = null

// One pass at a time. Two overlapping passes would both read an unstamped
// vehicle and both send, so a pass requested while one is running is folded
// into a single follow-up pass instead.
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runRegistrationExpiryTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[registration-expiry] tick failed', err)
      logSystemError('registration-expiry.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/**
 * Check now instead of on the next hourly tick — called after a vehicle is added
 * or its registration expiry is edited. Best effort and never throws.
 */
export function requestRegistrationExpiryCheck(): void {
  tick()
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startRegistrationExpiryScheduler(): void {
  if (timer) return

  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 25_000).unref?.()
}
