import * as notificationModel from '../../models/notification/notification.model.js'
import * as reminderModel from '../../models/driver/license-reminder.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { phDay } from '../../lib/ph-date.js'
import { sendLicenseExpiryEmail, sendLicenseExpiryStaffEmail, supportInboxEmail } from '../../lib/brevo-mailer.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { NotificationRow } from '../../types/notification.types.js'

/**
 * Driver's license expiry reminders, in three stages: one calendar month
 * before, 7 days before, and on the expiry day itself.
 *
 *   - the driver: in the app (row + realtime + push) and by email;
 *   - every active Company Administrator and Operations Manager: in the app only
 *     (the user's call — no email to staff), so whoever assigns and whoever
 *     updates the record knows before the assignment block bites;
 *   - the 8338 inbox: by email, for the company's own record.
 *
 * Each stage goes out once per expiry date, per channel. A driver whose date is
 * entered already inside the window gets only the most urgent stage, not a
 * burst of three. A renewal changes license_expiry, nothing matches any more,
 * and the new date starts over. Each mark is written only after its send lands,
 * so a failure is retried on the next hourly tick without repeating the others.
 *
 * The driver's one-month reminder keeps its original stamps
 * (license_reminder_notified_for / _emailed_for); everything else is recorded
 * in drivers.license_reminders as "<expiry>|<stage>|<channel>".
 */

const TICK_MS = 60 * 60 * 1000
const DAY_MS  = 24 * 60 * 60 * 1000

const TYPE       = 'driver.license_expiring' as const
const STAFF_TYPE = 'driver.license_expiring_staff' as const

type Stage   = 'month' | 'week' | 'day'
type Channel = 'driver_app' | 'driver_email' | 'staff_app' | 'inbox_email'

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

/** The most urgent stage that applies today. */
function stageFor(daysLeft: number): Stage {
  return daysLeft <= 0 ? 'day' : daysLeft <= 7 ? 'week' : 'month'
}

function sent(c: reminderModel.LicenseReminderCandidate, stage: Stage, channel: Channel): boolean {
  if (stage === 'month' && channel === 'driver_app')   return c.license_reminder_notified_for === c.license_expiry
  if (stage === 'month' && channel === 'driver_email') return c.license_reminder_emailed_for === c.license_expiry
  return !!c.license_reminders[`${c.license_expiry}|${stage}|${channel}`]
}

async function mark(c: reminderModel.LicenseReminderCandidate, stage: Stage, channel: Channel): Promise<void> {
  if (stage === 'month' && channel === 'driver_app')   return reminderModel.markReminded(c.driver_id, 'notified', c.license_expiry)
  if (stage === 'month' && channel === 'driver_email') return reminderModel.markReminded(c.driver_id, 'emailed', c.license_expiry)
  const key = `${c.license_expiry}|${stage}|${channel}`
  await reminderModel.markStage(c.driver_id, key)
  c.license_reminders[key] = new Date().toISOString()
}

const driverName = (c: reminderModel.LicenseReminderCandidate) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || 'A driver'

async function notifyDriver(c: reminderModel.LicenseReminderCandidate, expiresOn: string, daysLeft: number) {
  const title = daysLeft <= 0 ? 'Your driver\'s license expires today' : 'Your driver\'s license expires soon'
  const body  =
    `Your driver's license expires on ${expiresOn} (${inDaysPhrase(daysLeft)}). ` +
    'Renew it, then give the new expiry date and a photo to the Company Administrator. ' +
    'Once it expires you cannot be assigned to a delivery.'
  const data  = { type: TYPE, license_expiry: c.license_expiry }

  const [row] = await notificationModel.insertMany([
    { user_id: c.user_id, type: TYPE, title, body, booking_id: null, data },
  ])
  // Realtime and push are best effort; the stored row is the notification.
  if (row) {
    void broadcast(`notifications:user:${row.user_id}`, 'new_notification', row as NotificationRow).catch(() => {})
  }
  void push.sendToUsers([c.user_id], { title, body, data })
}

/** Where the office opens the driver: User Management for the Company Administrator, the dashboard for Operations. */
const officeUrl = (role: string) => (role === 'admin' ? '/admin/user-management' : '/operations_admin/dashboard')

async function notifyOffice(
  c: reminderModel.LicenseReminderCandidate,
  recipients: Array<{ user_id: string; role: string }>,
  expiresOn: string,
  daysLeft: number,
) {
  const name  = driverName(c)
  const title = daysLeft <= 0 ? `${name}'s license expires today` : `${name}'s license expires ${inDaysPhrase(daysLeft)}`
  const body  =
    `${name}'s driver's license${c.license_number ? ` (${c.license_number})` : ''} expires on ${expiresOn}. ` +
    'Once it expires they cannot be assigned. Record the renewed license in User Management when they have it.'
  const base  = { type: STAFF_TYPE, driver_id: c.driver_id, driver_name: name, license_expiry: c.license_expiry }

  const rows = await notificationModel.insertMany(recipients.map((r) => ({
    user_id: r.user_id, type: STAFF_TYPE, title, body, booking_id: null,
    data:    { ...base, action_url: officeUrl(r.role) },
  })))
  for (const row of rows ?? []) {
    void broadcast(`notifications:user:${row.user_id}`, 'new_notification', row as NotificationRow).catch(() => {})
  }
  for (const role of new Set(recipients.map((r) => r.role))) {
    const ids = recipients.filter((r) => r.role === role).map((r) => r.user_id)
    void push.sendToUsers(ids, { title, body, data: { ...base, action_url: officeUrl(role) } })
  }
}

/** One pass. Exported so it can be driven from a script. */
export async function runLicenseExpiryTick(now = new Date()): Promise<Record<Channel, number>> {
  const today  = phDay(now)
  const cutoff = addOneMonth(today)
  const rows   = await reminderModel.findExpiringBetween(today, cutoff)
  const office = rows.length > 0 ? await reminderModel.findOfficeRecipients() : []
  const inbox  = supportInboxEmail()

  const counts: Record<Channel, number> = { driver_app: 0, driver_email: 0, staff_app: 0, inbox_email: 0 }

  const attempt = async (c: reminderModel.LicenseReminderCandidate, stage: Stage, channel: Channel, send: () => Promise<unknown>) => {
    if (sent(c, stage, channel)) return
    try {
      await send()
      await mark(c, stage, channel)
      counts[channel]++
    } catch (err) {
      console.error(`[license-expiry] ${channel} reminder failed for driver`, c.driver_id, err)
      logSystemError('license-expiry.scheduler', 'cron_job', err, { driver_id: c.driver_id, channel, stage })
    }
  }

  for (const c of rows) {
    const expiresOn = formatDay(c.license_expiry)
    const daysLeft  = daysBetween(today, c.license_expiry)
    const stage     = stageFor(daysLeft)

    await attempt(c, stage, 'driver_app', () => notifyDriver(c, expiresOn, daysLeft))
    // No email on file (a vendor driver can be passkey-only) is not a failure:
    // the in-app reminder reaches them, and the office is told either way.
    if (c.email) {
      await attempt(c, stage, 'driver_email', () => sendLicenseExpiryEmail({
        to: c.email!, firstName: c.first_name, expiresOn, daysLeft, licenseNumber: c.license_number,
      }))
    }
    // Nobody in the office yet: leave it unmarked so it goes out once someone is.
    if (office.length > 0) await attempt(c, stage, 'staff_app', () => notifyOffice(c, office, expiresOn, daysLeft))
    await attempt(c, stage, 'inbox_email', () => sendLicenseExpiryStaffEmail({
      to: inbox, driverName: driverName(c), licenseNumber: c.license_number, expiresOn, daysLeft,
    }))
  }

  // Heartbeat on success too, so the IT Admin dashboard can tell a quiet day
  // from a stopped scheduler.
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'license-expiry.scheduler',
    message:    `License expiry tick: driver ${counts.driver_app} in-app / ${counts.driver_email} email, office ${counts.staff_app} in-app, inbox ${counts.inbox_email} email`,
    metadata:   { candidates: rows.length, office: office.length, ...counts, window_end: cutoff },
  })

  return counts
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
