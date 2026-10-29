import type { MaintenanceReason } from './truck.service.js'
import { matchesWords } from '../../lib/paginate.js'

/**
 * Vehicle Management → Upkeep, ONE ROW PER PROBLEM, built on the server so the
 * table can page there. A truck with an overdue service and a failed inspection
 * is two rows; each open driver report is a row of its own.
 *
 * Problems that block assignment come first, oldest first (the queue is worked
 * first in, first out); heads-ups follow. The wording of each row (the details
 * column) stays in the web app, which has the formatters for it.
 */

type ProblemType = 'inspection' | 'service' | 'report' | 'odometer' | 'registration'
type NeedGroup   = 'blowbagets' | 'vehicle_maintenance' | 'driver_report'

const NEEDS: Record<MaintenanceReason, { group: NeedGroup; blocking: boolean; type: ProblemType }> = {
  return_odometer_due:      { group: 'vehicle_maintenance', blocking: true,  type: 'odometer'   },
  recheck_due:              { group: 'blowbagets',          blocking: true,  type: 'inspection' },
  never_inspected:          { group: 'blowbagets',          blocking: true,  type: 'inspection' },
  failed_inspection:        { group: 'blowbagets',          blocking: true,  type: 'inspection' },
  under_maintenance:        { group: 'vehicle_maintenance', blocking: true,  type: 'inspection' },
  driver_report:            { group: 'driver_report',       blocking: true,  type: 'report'     },
  service_overdue:          { group: 'vehicle_maintenance', blocking: true,  type: 'service'    },
  service_due_soon:         { group: 'vehicle_maintenance', blocking: false, type: 'service'    },
  service_schedule_missing: { group: 'vehicle_maintenance', blocking: false, type: 'service'    },
  registration_expired:     { group: 'vehicle_maintenance', blocking: true,  type: 'registration' },
  registration_expiring:    { group: 'vehicle_maintenance', blocking: false, type: 'registration' },
  registration_missing:     { group: 'vehicle_maintenance', blocking: false, type: 'registration' },
}

export interface UpkeepProblem {
  key:      string
  truck:    any
  reason:   MaintenanceReason
  report?:  any
  group:    NeedGroup
  since:    string | null
  blocking: boolean
  type:     ProblemType
}

/** When the problem started, for the oldest-first order. */
function sinceOf(t: any, reason: MaintenanceReason): string | null {
  switch (reason) {
    case 'return_odometer_due':
    case 'recheck_due':              return t.last_fleet_return_at ?? null
    case 'never_inspected':
    case 'service_schedule_missing':
    case 'registration_missing':     return t.created_at ?? null
    case 'failed_inspection':        return t.latest_inspection?.inspected_at ?? null
    case 'under_maintenance':        return t.updated_at ?? null
    case 'service_overdue':          return t.service_status?.due_date ? `${t.service_status.due_date}T00:00:00+08:00` : null
    case 'registration_expired':     return t.registration_expiry ? `${t.registration_expiry}T00:00:00+08:00` : null
    default:                         return null
  }
}

/** Explode each vehicle of the maintenance queue into one row per problem, in queue order. */
export function toProblems(trucks: any[]): UpkeepProblem[] {
  const out: UpkeepProblem[] = []
  for (const t of trucks) {
    for (const reason of t.maintenance_reasons as MaintenanceReason[]) {
      // A failed inspection takes the truck out of service as well; one row says it all.
      if (reason === 'under_maintenance' && t.maintenance_reasons.includes('failed_inspection')) continue
      const base = { truck: t, reason, ...NEEDS[reason] }
      if (reason === 'driver_report') {
        for (const r of t.open_reports ?? []) {
          out.push({ ...base, key: `${t.truck_id}:${r.report_id}`, report: r, since: r.created_at ?? null })
        }
        continue
      }
      out.push({ ...base, key: `${t.truck_id}:${reason}`, since: sinceOf(t, reason) })
    }
  }
  // Blocking first; within each group, oldest first (no date sorts last).
  return out.sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
    if (!a.since || !b.since) return a.since ? -1 : b.since ? 1 : 0
    return new Date(a.since).getTime() - new Date(b.since).getTime()
  })
}

/**
 * The rows the Upkeep table shows: the group filter ('all', a need group, or
 * 'odometer'), the search (plate, model, vehicle type, regular driver), and the
 * focused vehicle's rows moved to the top.
 */
export function filterProblems(
  problems: UpkeepProblem[],
  opts: { group: string; search: string; focusId: string | null },
): UpkeepProblem[] {
  const q = opts.search.trim().toLowerCase()
  const visible = problems.filter((p) => {
    if (opts.group === 'odometer' && p.type !== 'odometer') return false
    if (opts.group !== 'all' && opts.group !== 'odometer' && p.group !== opts.group) return false
    const d = p.truck.assigned_driver
    const driver = d ? `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim() : null
    // The search box reads "Search plate, model, driver...": those, nothing else.
    return matchesWords(q, [p.truck.plate_number, p.truck.truck_model?.name, driver])
  })
  if (!opts.focusId) return visible
  return [
    ...visible.filter((p) => p.truck.truck_id === opts.focusId),
    ...visible.filter((p) => p.truck.truck_id !== opts.focusId),
  ]
}
