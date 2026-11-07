import { addOneMonth, daysBetween } from './registration-expiry.js'

/**
 * The reminder days shared by every expiry reminder (driver's license, vehicle
 * registration, client contract), user's schedule 2026-11-07:
 *
 *   1 month, 3 weeks, 2 weeks, 1 week, then 6, 5, 4, 3, 2 and 1 day before,
 *   and on the expiry day itself.
 *
 * Each stage is sent once per expiry date. A pass works out the most urgent
 * stage that applies TODAY, so a date entered late (or a server that was down
 * on a reminder day) gets one catch-up reminder for the current stage instead
 * of a burst of every stage it missed.
 *
 * 'week' and 'day' keep the key names the license reminder already stored
 * (2026-11-01), so a reminder sent before this change is not sent again.
 */
export type ReminderStage =
  | 'month' | '21d' | '14d' | 'week'
  | '6d' | '5d' | '4d' | '3d' | '2d' | '1d'
  | 'day'

/** The stage that applies today, or null when the date is past or more than a month out. */
export function reminderStageFor(today: string, expiry: string): ReminderStage | null {
  const d = daysBetween(today, expiry)
  if (d < 0)  return null
  if (d === 0) return 'day'
  if (d <= 6)  return `${d}d` as ReminderStage
  if (d <= 7)  return 'week'
  if (d <= 14) return '14d'
  if (d <= 21) return '21d'
  return expiry <= addOneMonth(today) ? 'month' : null
}

/** "today" / "tomorrow" / "in 5 days" / "in 3 weeks" / "in 1 month". */
export function inDaysPhrase(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === 7) return 'in 1 week'
  if (days === 14) return 'in 2 weeks'
  if (days === 21) return 'in 3 weeks'
  if (days >= 28) return 'in 1 month'
  return `in ${days} days`
}

/** "November 4, 2026": a plain date, so it is formatted as UTC to avoid a day shift. */
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: 'UTC' })
    .format(new Date(`${day}T00:00:00Z`))
}

/** Key in a `*_reminders` jsonb map: "<expiry>|<stage>|<channel>". */
export const reminderKey = (expiry: string, stage: ReminderStage, channel: string) => `${expiry}|${stage}|${channel}`
