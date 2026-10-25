import { phDay, asDay } from './ph-date.js'

/**
 * Vehicle registration validity. `registration_expiry` is the last day the
 * registration is valid, so a vehicle is expired from the day after.
 * Mirrored in logistics-frontend/src/lib/registration-expiry.ts.
 *
 *   missing  — no date entered yet (vehicles from before the field existed);
 *              flagged on Upkeep, not blocked
 *   ok       — valid for more than a calendar month
 *   expiring — expires within one calendar month (the reminder window)
 *   expired  — past the date; the vehicle cannot be assigned
 */
export type RegistrationState = 'missing' | 'ok' | 'expiring' | 'expired'

export interface RegistrationStatus {
  state:       RegistrationState
  /** `YYYY-MM-DD` */
  expires_on:  string | null
  days_left:   number | null
}

/** `YYYY-MM-DD` plus one calendar month, clamped to the end of a shorter month. */
export function addOneMonth(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(d, lastOfNext))).toISOString().slice(0, 10)
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000)
}

export function registrationStatus(expiry: unknown, today: string = phDay()): RegistrationStatus {
  const expires_on = asDay(expiry as string | Date | null)
  if (!expires_on) return { state: 'missing', expires_on: null, days_left: null }

  const days_left = daysBetween(today, expires_on)
  const state: RegistrationState =
    expires_on < today            ? 'expired'
    : expires_on <= addOneMonth(today) ? 'expiring'
    : 'ok'
  return { state, expires_on, days_left }
}
