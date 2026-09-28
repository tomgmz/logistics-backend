import { phDay } from './ph-date.js'

/**
 * Routine maintenance: a vehicle is due every `service_interval_km` OR every
 * `service_interval_months` since its last service, whichever comes first.
 * Mirrored in logistics-frontend/src/app/types/truck.types.ts (serviceStatus).
 *
 *   missing  — the schedule or a reading hasn't been entered, so nothing can
 *              be worked out (flagged on Maintenance, not blocked)
 *   ok       — nothing due
 *   due_soon — within 10% of the km interval, or 7 days of the date
 *   overdue  — past either limit; the vehicle cannot be assigned
 */
export type ServiceState = 'missing' | 'ok' | 'due_soon' | 'overdue'

export interface ServiceScheduleFields {
  service_interval_km:      number | null
  service_interval_months:  number | null
  /** `YYYY-MM-DD` */
  last_service_at:          string | null
  last_service_odometer_km: number | null
  odometer_km:              number | null
}

export interface ServiceStatus {
  state:       ServiceState
  due_km:      number | null
  /** `YYYY-MM-DD` */
  due_date:    string | null
  km_left:     number | null
  days_left:   number | null
}

const DUE_SOON_DAYS = 7
const DUE_SOON_KM_SHARE = 0.1

/** `YYYY-MM-DD` plus N calendar months, clamped to the month's last day. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return target.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export function serviceStatus(t: ServiceScheduleFields, today: string = phDay()): ServiceStatus {
  const { service_interval_km: everyKm, service_interval_months: everyMonths } = t
  if (
    everyKm == null || everyMonths == null ||
    !t.last_service_at || t.last_service_odometer_km == null || t.odometer_km == null
  ) {
    return { state: 'missing', due_km: null, due_date: null, km_left: null, days_left: null }
  }

  const due_km    = t.last_service_odometer_km + everyKm
  const due_date  = addMonths(t.last_service_at, everyMonths)
  const km_left   = due_km - t.odometer_km
  const days_left = daysBetween(today, due_date)

  const state: ServiceState =
    km_left <= 0 || days_left <= 0 ? 'overdue'
    : km_left <= everyKm * DUE_SOON_KM_SHARE || days_left <= DUE_SOON_DAYS ? 'due_soon'
    : 'ok'

  return { state, due_km, due_date, km_left, days_left }
}
