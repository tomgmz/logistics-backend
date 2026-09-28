import * as TruckModel from '../../models/admin/truck.model.js'
import * as InspectionModel from '../../models/admin/truck-inspection.model.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'
import { logEvent } from '../../lib/log-event.js'
import { lastFleetReturnsFor } from '../../lib/driver-reservation.js'
import { listOpenVehicleReportsService } from '../driver/report.service.js'
import type { DriverReport } from '../../types/driver/report.types.js'
import * as UpkeepModel from '../../models/admin/truck-upkeep.model.js'
import { scheduleOf, returnOdometerDue, assertReadingPlausible } from './truck-upkeep.service.js'
import { serviceStatus, type ServiceStatus } from '../../lib/service-schedule.js'
import { phDay } from '../../lib/ph-date.js'

/**
 * Attach each vehicle's most recent BLOWBAGETS inspection, and when it last came
 * home. Operations picks from this list, so readiness has to travel with the
 * row — `latest_inspection` is null for a vehicle that has never been inspected,
 * which reads as "not ready".
 *
 * `last_fleet_return_at` travels with it because a pass alone no longer means
 * ready: the clearance expires when the vehicle returns to the yard, so the
 * caller needs both dates to tell a cleared vehicle from one awaiting its
 * re-check. Without it the dropdown would offer vehicles the assignment call
 * then refuses.
 */
async function withLatestInspection<T extends { truck_id: string }>(rows: T[]) {
  type Enriched = T & {
    latest_inspection:    InspectionModel.TruckInspection | null
    last_fleet_return_at: string | null
    last_service_at:      string | null
    service_status:       ServiceStatus
    return_odometer_due:  boolean
  }
  if (rows.length === 0) return [] as Enriched[]

  const [latest, returns] = await Promise.all([
    InspectionModel.latestByTruck(),
    lastFleetReturnsFor(rows.map((r) => r.truck_id)),
  ])

  const today = phDay()
  return rows.map((row) => {
    const schedule   = scheduleOf(row)
    const lastReturn = returns.get(row.truck_id) ?? null
    return {
      ...row,
      latest_inspection:    latest.get(row.truck_id) ?? null,
      last_fleet_return_at: lastReturn,
      // pg hands a `date` back as a Date at local midnight; send the calendar day.
      last_service_at:      schedule.last_service_at,
      // Routine service, worked out once here so every screen agrees.
      service_status:       serviceStatus(schedule, today),
      // The Fleet Manager still owes the after-delivery odometer.
      return_odometer_due:  returnOdometerDue(row as any, lastReturn),
    }
  }) as Enriched[]
}

export interface PaginatedTrucksMeta {
  total:      number
  page:       number
  limit:      number
  totalPages: number
}

export async function getAllTrucksPaginated(params: {
  page:     number
  limit:    number
  status?:  string | null
  search?:  string | null
}): Promise<{ data: Awaited<ReturnType<typeof TruckModel.findAllPaginated>>['rows']; meta: PaginatedTrucksMeta }> {
  const page  = Math.max(1, params.page)
  const limit = Math.min(Math.max(1, params.limit), 100)

  const { rows, total } = await TruckModel.findAllPaginated({
    page,
    limit,
    status:   params.status,
    search:   params.search,
  })

  const totalPages = Math.max(1, Math.ceil(total / limit))

  return {
    data: await withLatestInspection(rows),
    meta: { total, page, limit, totalPages },
  }
}

export async function getAllTrucks() {
  return withLatestInspection(await TruckModel.findAll())
}

/**
 * Why a vehicle is on the Maintenance tab. A truck can carry several at once
 * (a failed inspection also sets under_maintenance, for instance).
 *
 *   under_maintenance — someone took it out of service
 *   failed_inspection — its latest BLOWBAGETS failed
 *   driver_report     — a driver has an unresolved breakdown/accident open on it
 *
 *   service_*         — routine service overdue / due soon / not set up
 *
 * BLOWBAGETS re-checks (never inspected, back from a job) are NOT maintenance:
 * the vehicle is fine, it just needs a look, and the Vehicles tab already
 * offers "Approve Vehicle" for those.
 */
export type MaintenanceReason =
  | 'under_maintenance'
  | 'failed_inspection'
  | 'driver_report'
  | 'service_overdue'        // past the km or the date — blocked from assignment
  | 'service_due_soon'       // within 10% of the km interval or 7 days
  | 'service_schedule_missing' // no schedule / reading entered yet (older vehicles)

export async function getMaintenanceQueue() {
  const [trucks, reports] = await Promise.all([
    getAllTrucks(),
    listOpenVehicleReportsService(),
  ])

  const reportsByTruck = new Map<string, DriverReport[]>()
  for (const r of reports) {
    if (!r.truck_id) continue
    const list = reportsByTruck.get(r.truck_id) ?? []
    list.push(r)
    reportsByTruck.set(r.truck_id, list)
  }

  return trucks
    .map((t: any) => {
      const reasons: MaintenanceReason[] = []
      if (t.status === 'under_maintenance') reasons.push('under_maintenance')
      if (t.latest_inspection && !t.latest_inspection.passed) reasons.push('failed_inspection')
      const open = reportsByTruck.get(t.truck_id) ?? []
      if (open.length > 0) reasons.push('driver_report')
      const service = t.service_status?.state
      if (service === 'overdue')  reasons.push('service_overdue')
      if (service === 'due_soon') reasons.push('service_due_soon')
      if (service === 'missing')  reasons.push('service_schedule_missing')
      return { ...t, maintenance_reasons: reasons, open_reports: open }
    })
    .filter((t) => t.maintenance_reasons.length > 0)
}

export async function getTruckById(truckId: string) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')
  const [withInspection] = await withLatestInspection([truck])
  return withInspection
}

function assertBaselinePlausible(input: {
  last_service_at?: string
  last_service_odometer_km?: number
}, odometerKm: number | null | undefined): void {
  if (input.last_service_at && input.last_service_at > phDay()) {
    throw new Error('The last service date cannot be in the future')
  }
  if (input.last_service_odometer_km != null && odometerKm != null && input.last_service_odometer_km > odometerKm) {
    throw new Error('The last service odometer cannot be higher than the current odometer')
  }
}

export async function createTruck(input: CreateTruckInput, actorId?: string | null) {
  assertBaselinePlausible(input, input.odometer_km)

  const result = await TruckModel.create(input)
  if (result && input.odometer_km != null) {
    await UpkeepModel.insertReading({
      truck_id:    result.truck_id,
      reading_km:  input.odometer_km,
      kind:        'initial',
      photo_url:   input.odometer_photo_url ?? null,
      recorded_by: actorId ?? null,
    })
  }

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_created',
    description: `Vehicle ${input.plate_number} created`,

  })

  return result ? getTruckById(result.truck_id) : result
}

/**
 * Throws unless this driver can be made `truckId`'s regular driver.
 *
 * A driver has one truck and a truck has one driver — the database enforces that
 * with a partial unique index, but a raw constraint violation reaches the fleet
 * manager as a wall of Postgres text. This asks first so the answer names the
 * vehicle they need to unpair.
 */
async function assertDriverNotAlreadyPaired(truckId: string, driverId: string): Promise<void> {
  const existing = await TruckModel.findByAssignedDriver(driverId)
  if (existing && existing.truck_id !== truckId) {
    throw new Error(
      `That driver is already the regular driver of ${existing.plate_number} — ` +
      'unpair that vehicle first, or pick another driver',
    )
  }
}

export async function updateTruck(truckId: string, input: UpdateTruckInput, actorId?: string | null) {
  if (input.assigned_driver_id) {
    await assertDriverNotAlreadyPaired(truckId, input.assigned_driver_id)
  }

  const { odometer_km: initialOdometer, ...fields } = input
  const settingBaseline = input.last_service_at !== undefined || input.last_service_odometer_km !== undefined
  if (settingBaseline || initialOdometer !== undefined) {
    const current = await TruckModel.findById(truckId)
    if (!current) throw new Error('Truck not found')
    // Once set, the last service moves only through Record Service, and the
    // odometer only through readings — both keep a history this edit would skip.
    if (settingBaseline && current.last_service_at) {
      throw new Error('The last service is already set — use Record Service to log a new one')
    }
    if (initialOdometer !== undefined && current.odometer_km != null) {
      throw new Error('The odometer is already set — it moves with the before and after delivery readings')
    }
    assertBaselinePlausible(input, initialOdometer ?? current.odometer_km)
    if (initialOdometer !== undefined) assertReadingPlausible(current, initialOdometer)
  }

  const result = await TruckModel.update(truckId, fields)
  if (initialOdometer !== undefined) {
    await UpkeepModel.insertReading({
      truck_id: truckId, reading_km: initialOdometer, kind: 'initial', recorded_by: actorId ?? null,
    })
  }

  // Pairing is a fleet decision someone will be asked about later ("why was
  // Juan on that truck?"), so it goes on the record as its own line rather than
  // disappearing into a generic 'updated'.
  if (input.assigned_driver_id !== undefined) {
    logEvent({
      user_id:     actorId,
      log_type:    'vehicle_activity',
      action:      input.assigned_driver_id ? 'vehicle_driver_paired' : 'vehicle_driver_unpaired',
      description: input.assigned_driver_id
        ? `Vehicle ${result?.plate_number ?? truckId} paired with driver ${input.assigned_driver_id}`
        : `Vehicle ${result?.plate_number ?? truckId} unpaired from its regular driver`,
    })
  } else {
    logEvent({
      user_id:     actorId,
      log_type:    'vehicle_activity',
      action:      'vehicle_updated',
      description: `Vehicle ${truckId} updated`,
    })
  }

  return result
}

export async function archiveTruck(truckId: string, actorId?: string | null) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error(`No truck found with ID: ${truckId}`)
  if (truck.status === 'in_use') {
    throw new Error(`${truck.plate_number} is out on a booking — archive it once it is back in the yard`)
  }

  const result = await TruckModel.archive(truckId)
  // Only reachable if a booking took the vehicle between the read and the write.
  if (!result) {
    throw new Error(`${truck.plate_number} is out on a booking — archive it once it is back in the yard`)
  }

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_archived',
    description: truck.assigned_driver_id
      ? `Vehicle ${truck.plate_number} archived and unpaired from its regular driver`
      : `Vehicle ${truck.plate_number} archived`,
  })

  return result
}
