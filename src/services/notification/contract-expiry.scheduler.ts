import * as notificationModel from '../../models/notification/notification.model.js'
import * as reminderModel from '../../models/admin/contract-reminder.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { phDay } from '../../lib/ph-date.js'
import { addOneMonth, daysBetween } from '../../lib/registration-expiry.js'
import { reminderStageFor, inDaysPhrase, formatDay, reminderKey, type ReminderStage } from '../../lib/expiry-reminder-stages.js'
import { sendContractExpiryClientEmail, sendContractExpiryStaffEmail } from '../../lib/brevo-mailer.js'
import { logSystem, logSystemError } from '../../lib/log-system.js'
import { NotificationRow } from '../../types/notification.types.js'

/**
 * Client contract expiry reminders (clients.contract_valid_until), built
 * 2026-11-07 on the shared schedule (lib/expiry-reminder-stages): 1 month,
 * 3 weeks, 2 weeks, 1 week, then 6..1 days before, and on the last valid day.
 *
 *   - the client: in the app (row + realtime + push) and by email;
 *   - every active Company Administrator, General Manager and Operations
 *     Manager: in the app (row + realtime + push) and by email, one each.
 *
 * Each stage goes out once per expiry date, per channel (staff email per
 * person, so one bounced address is retried alone). Marks are recorded in
 * clients.contract_reminders as "<expiry>|<stage>|<channel>", written only
 * after the send lands, so a failure is retried on the next hourly tick. A
 * renewal changes contract_valid_until and the new date starts over. A date
 * entered inside the window gets only the most urgent stage.
 *
 * After the date: booking closes, sign-in closes 7 days later (lib/contract-status).
 */

const TICK_MS = 60 * 60 * 1000

const CLIENT_TYPE = 'client.contract_expiring' as const
const STAFF_TYPE  = 'client.contract_expiring_staff' as const

type Channel = 'client_app' | 'client_email' | 'staff_app' | `staff_email:${string}`

const CLIENT_URL = '/client/dashboard'

/** Where each office role opens the client: User Management for the Company Administrator, their dashboard otherwise. */
function officeUrl(role: string): string {
  if (role === 'admin')           return '/admin/user-management'
  if (role === 'general_manager') return '/general_manager/dashboard'
  return '/operations_admin/dashboard'
}

const contactName = (c: reminderModel.ContractReminderCandidate) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'The client'

const companyOf = (c: reminderModel.ContractReminderCandidate) => c.company_name?.trim() || contactName(c)

function sent(c: reminderModel.ContractReminderCandidate, stage: ReminderStage, channel: Channel): boolean {
  return !!c.contract_reminders[reminderKey(c.contract_valid_until, stage, channel)]
}

async function mark(c: reminderModel.ContractReminderCandidate, stage: ReminderStage, channel: Channel): Promise<void> {
  const key = reminderKey(c.contract_valid_until, stage, channel)
  await reminderModel.markStage(c.client_id, key)
  c.contract_reminders[key] = new Date().toISOString()
}

async function notifyClient(c: reminderModel.ContractReminderCandidate, expiresOn: string, daysLeft: number) {
  const title = daysLeft <= 0 ? 'Your contract ends today' : `Your contract ends ${inDaysPhrase(daysLeft)}`
  const body  =
    `Your delivery contract with 8338 is valid until ${expiresOn}. ` +
    'Contact us to renew it. Once it ends, new bookings are closed; you can still sign in and view your data for 7 days, then sign-in closes until it is renewed.'
  const data  = { type: CLIENT_TYPE, contract_valid_until: c.contract_valid_until, action_url: CLIENT_URL }

  const [row] = await notificationModel.insertMany([
    { user_id: c.user_id, type: CLIENT_TYPE, title, body, booking_id: null, data },
  ])
  // Realtime and push are best effort; the stored row is the notification.
  if (row) {
    void broadcast(`notifications:user:${row.user_id}`, 'new_notification', row as NotificationRow).catch(() => {})
  }
  void push.sendToUsers([c.user_id], { title, body, data })
}

async function notifyOffice(
  c: reminderModel.ContractReminderCandidate,
  recipients: reminderModel.ContractReminderRecipient[],
  expiresOn: string,
  daysLeft: number,
) {
  const company = companyOf(c)
  const title   = daysLeft <= 0 ? `${company}'s contract ends today` : `${company}'s contract ends ${inDaysPhrase(daysLeft)}`
  const body    =
    `The contract with ${company} is valid until ${expiresOn}. ` +
    'Arrange the renewal, then update "Contract Valid Until" in User Management. After it ends the client cannot book; 7 days later they cannot sign in.'
  const base    = { type: STAFF_TYPE, client_id: c.client_id, client_user_id: c.user_id, company_name: company, contract_valid_until: c.contract_valid_until }

  const rows = await notificationModel.insertMany(recipients.map((r) => ({
    user_id: r.user_id, type: STAFF_TYPE, title, body, booking_id: null,
    data:    { ...base, action_url: officeUrl(r.role) },
  })))
  for (const row of rows ?? []) {
    void broadcast(`notifications:user:${row.user_id}`, 'new_notification', row as NotificationRow).catch(() => {})
  }
  // Grouped by link so each person's push opens their own portal.
  for (const role of new Set(recipients.map((r) => r.role))) {
    const ids = recipients.filter((r) => r.role === role).map((r) => r.user_id)
    void push.sendToUsers(ids, { title, body, data: { ...base, action_url: officeUrl(role) } })
  }
}

/** One pass. Exported so it can be driven from a script. */
export async function runContractExpiryTick(now = new Date()): Promise<Record<'client_app' | 'client_email' | 'staff_app' | 'staff_email', number>> {
  const today  = phDay(now)
  const cutoff = addOneMonth(today)
  const rows   = await reminderModel.findExpiringBetween(today, cutoff)
  const office = rows.length > 0 ? await reminderModel.findOfficeRecipients() : []

  const counts = { client_app: 0, client_email: 0, staff_app: 0, staff_email: 0 }

  const attempt = async (
    c: reminderModel.ContractReminderCandidate, stage: ReminderStage, channel: Channel,
    counter: keyof typeof counts, send: () => Promise<unknown>,
  ) => {
    if (sent(c, stage, channel)) return
    try {
      await send()
      await mark(c, stage, channel)
      counts[counter]++
    } catch (err) {
      console.error(`[contract-expiry] ${channel} reminder failed for client`, c.client_id, err)
      logSystemError('contract-expiry.scheduler', 'cron_job', err, { client_id: c.client_id, channel, stage })
    }
  }

  for (const c of rows) {
    const stage = reminderStageFor(today, c.contract_valid_until)
    if (!stage) continue
    const expiresOn = formatDay(c.contract_valid_until)
    const daysLeft  = daysBetween(today, c.contract_valid_until)

    await attempt(c, stage, 'client_app', 'client_app', () => notifyClient(c, expiresOn, daysLeft))
    if (c.email) {
      await attempt(c, stage, 'client_email', 'client_email', () => sendContractExpiryClientEmail({
        to: c.email!, firstName: c.first_name, companyName: c.company_name, expiresOn, daysLeft,
      }))
    }

    // Nobody in the office yet: leave it unmarked so it goes out once someone is.
    if (office.length === 0) continue
    await attempt(c, stage, 'staff_app', 'staff_app', () => notifyOffice(c, office, expiresOn, daysLeft))
    for (const r of office) {
      if (!r.email) continue
      await attempt(c, stage, `staff_email:${r.user_id}`, 'staff_email', () => sendContractExpiryStaffEmail({
        to: r.email!, toName: r.first_name, clientName: contactName(c), companyName: c.company_name,
        clientEmail: c.email, expiresOn, daysLeft,
      }))
    }
  }

  // Heartbeat on success too, so the IT Admin dashboard can tell a quiet day
  // from a stopped scheduler.
  logSystem({
    log_level:  'info',
    event_type: 'cron_job',
    source:     'contract-expiry.scheduler',
    message:    `Contract expiry tick: client ${counts.client_app} in-app / ${counts.client_email} email, office ${counts.staff_app} in-app / ${counts.staff_email} email`,
    metadata:   { candidates: rows.length, office: office.length, ...counts, window_end: cutoff },
  })

  return counts
}

let timer: NodeJS.Timeout | null = null

// One pass at a time. Two overlapping passes would both read an unstamped
// client and both send, so a pass requested while one is running is folded into
// a single follow-up pass instead.
let running: Promise<void> | null = null
let rerun = false

function tick(): void {
  if (running) { rerun = true; return }
  running = runContractExpiryTick()
    .then(() => undefined)
    .catch((err) => {
      console.error('[contract-expiry] tick failed', err)
      logSystemError('contract-expiry.scheduler', 'cron_job', err)
    })
    .finally(() => {
      running = null
      if (rerun) { rerun = false; tick() }
    })
}

/**
 * Check now instead of on the next hourly tick: called after a client is added
 * or their contract date is edited. Best effort and never throws.
 */
export function requestContractExpiryCheck(): void {
  tick()
}

/** Start the recurring tick. Safe to call once at boot; a second call is ignored. */
export function startContractExpiryScheduler(): void {
  if (timer) return

  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 30_000).unref?.()
}
