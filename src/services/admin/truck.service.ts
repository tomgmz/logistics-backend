import * as TruckModel from '../../models/admin/truck.model.js'
import * as InspectionModel from '../../models/admin/truck-inspection.model.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'
import { logEvent } from '../../lib/log-event.js'
import { lastFleetReturnsFor } from '../../lib/driver-reservation.js'

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
  }
  if (rows.length === 0) return [] as Enriched[]

  const [latest, returns] = await Promise.all([
    InspectionModel.latestByTruck(),
    lastFleetReturnsFor(rows.map((r) => r.truck_id)),
  ])

  return rows.map((row) => ({
    ...row,
    latest_inspection:    latest.get(row.truck_id) ?? null,
    last_fleet_return_at: returns.get(row.truck_id) ?? null,
  })) as Enriched[]
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

export async function getTruckById(truckId: string) {
  const truck = await TruckModel.findById(truckId)
  if (!truck) throw new Error('Truck not found')
  const [withInspection] = await withLatestInspection([truck])
  return withInspection
}

export async function createTruck(input: CreateTruckInput, actorId?: string | null) {
  const result = await TruckModel.create(input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_created',
    description: `Vehicle ${input.plate_number} created`,

  })

  return result
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

  const result = await TruckModel.update(truckId, input)

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

export async function deleteTruck(truckId: string, actorId?: string | null) {
  const result = await TruckModel.remove(truckId)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_deleted',
    description: `Vehicle ${truckId} deleted`,

  })

  return result
}
