import * as notificationModel from '../../models/notification/notification.model.js'
import * as reminderModel from '../../models/driver/license-reminder.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { phDay } from '../../lib/ph-date.js'
import { sendLicenseExpiryEmail } from '../../lib/brevo-mailer.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { NotificationRow } from '../../types/notification.types.js'

/**
 * Tells each driver, one month ahead, that their driver's license is about to
 * expire — in the app (row + realtime + push) and by email.
 *
 * Once per expiry date, per channel: drivers.license_reminder_notified_for and
 * license_reminder_emailed_for hold the expiry date each reminder was sent for.
 * A renewal changes license_expiry, the stamps stop matching, and the new date
 * gets its own reminder a month out. Each stamp is written only after its send
 * lands, so a failed email is retried next tick without repeating the in-app one.
 *
 * "One month" is a calendar month in Philippine time: a license expiring on
 * November 5 is first reminded on October 5. A driver whose date is already
 * inside the window when it is entered (or when this first ships) is reminded on
 * the next tick. An expiry that has already passed is not "expiring soon" and is
 * left alone.
 *
 * Same in-process shape as the completion and fleet re-check schedulers.
 */

const TICK_MS = 60 * 60 * 1000
const DAY_MS  = 24 * 60 * 60 * 1000

const TYPE = 'driver.license_expiring' as const

/** `YYYY-MM-DD` plus one calendar month, clamped to the end of a shorter month. */
function addOneMonth(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(d, lastOfNext))).toISOString().slice(0, 10)
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS)
}

/** "November 4, 2026" — a plain date, so it is formatted as UTC to avoid a day shift. */
function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: 'UTC' })
    .format(new Date(`${day}T00:00:00Z`))
}

function inDaysPhrase(days: number): string {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

async function notifyInApp(c: reminderModel.LicenseReminderCandidate, expiresOn: string, daysLeft: number) {
  const title = 'Your driver\'s license expires soon'
  const body  =
    `Your driver's license expires on ${expiresOn} (${inDaysPhrase(daysLeft)}). ` +
    'Renew it, then give the new expiry date and a photo to the Company Administrator.'
  const data  = { type: TYPE, license_expiry: c.license_expiry }

  const [row] = await notificationModel.insertMany([
    { user_id: c.user_id, type: TYPE, title, body, booking_id: null, data },
  ])

  // Realtime and push are best effort; the stored row is the notification.
  if (row) {
    void broadcast(`notifications:user:${row.user_id}`, 'new_notification', row as NotificationRow)
      .catch(() => {})
  }
  void push.sendToUsers([c.user_id], { title, body, data })
}

/** One pass. Exported so it can be driven from a script. */
export async function runLicenseExpiryTick(now = new Date()): Promise<{ notified: number; emailed: number }> {
  const today  = phDay(now)
  const cutoff = addOneMonth(today)
  const rows   = await reminderModel.findExpiringBetween(today, cutoff)

  let notified = 0
  let emailed  = 0

  for (const c of rows) {
    const expiresOn = formatDay(c.license_expiry)
    const daysLeft  = daysBetween(today, c.license_expiry)

    if (c.license_reminder_notified_for !== c.license_expiry) {
      try {
        await notifyInApp(c, expiresOn, daysLeft)
        await reminderModel.markReminded(c.driver_id, 'notified', c.license_expiry)
        notified++
      } catch (err) {
        console.error('[license-expiry] in-app reminder failed for driver', c.driver_id, err)
        logSystemError('license-expiry.scheduler', 'cron_job', err, { driver_id: c.driver_id, channel: 'in_app' })
      }
    }

    // No email on file (an external driver can be passkey-only) is not a failure;
    // the in-app reminder above still reaches them.
    if (c.email && c.license_reminder_emailed_for !== c.license_expiry) {
      try {
        await sendLicenseExpiryEmail({
          to:            c.email,
          firstName:     c.first_name,
          expiresOn,
          daysLeft,
          licenseNumber: c.license_number,
        })
        await reminderModel.markReminded(c.driver_id, 'emailed', c.license_expiry)
        emailed++
      } catch (err) {
        // The mailer already wrote the email_event row; this one is for the job.
        console.error('[license-expiry] email reminder failed for driver', c.driver_id, err)
        logSystemError('license-expiry.scheduler', 'cron_job', err, { driver_id: c.driver_id, channel: 'email' })
      }
    }
  }

  // Heartbeat on success too, so the IT Admin dashboard can tell a quiet day
  // from a stopped scheduler.
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'license-expiry.scheduler',
    message:    `License expiry tick: ${notified} in-app, ${emailed} email reminder(s) sent`,
    metadata:   { candidates: rows.length, notified, emailed, window_end: cutoff },
  })

  return { notified, emailed }
}

let timer: NodeJS.Timeout | null = null

// One pass at a time. Two overlapping passes would both read an unstamped driver
// and both send, so a pass requested while one is running is folded into a
// single follow-up pass instead.
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runLicenseExpiryTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[license-expiry] tick failed', err)
      logSystemError('license-expiry.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/**
 * Check now instead of on the next hourly tick — called after a driver is added
 * or their license expiry is edited, so a license already inside the window is
 * reminded straight away. Best effort and never throws into the caller.
 */
export function requestLicenseExpiryCheck(): void {
  tick()
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startLicenseExpiryScheduler(): void {
  if (timer) return

  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 20_000).unref?.()
}
