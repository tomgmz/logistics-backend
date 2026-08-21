import * as TruckModel from '../../models/admin/truck.model.js'
import * as InspectionModel from '../../models/admin/truck-inspection.model.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'
import { logEvent } from '../../lib/log-event.js'

/**
 * Attach each vehicle's most recent BLOWBAGETS inspection. Operations picks from
 * this list, so readiness has to travel with the row — `latest_inspection` is
 * null for a vehicle that has never been inspected, which reads as "not ready".
 */
async function withLatestInspection<T extends { truck_id: string }>(rows: T[]) {
  if (rows.length === 0) return rows as (T & { latest_inspection: InspectionModel.TruckInspection | null })[]
  const latest = await InspectionModel.latestByTruck()
  return rows.map((row) => ({ ...row, latest_inspection: latest.get(row.truck_id) ?? null }))
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

export async function createTruck(input: CreateTruckInput, actorId?: string | null, ip?: string | null) {
  const result = await TruckModel.create(input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_created',
    description: `Vehicle ${input.plate_number} created`,

  })

  return result
}

export async function updateTruck(truckId: string, input: UpdateTruckInput, actorId?: string | null, ip?: string | null) {
  const result = await TruckModel.update(truckId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_updated',
    description: `Vehicle ${truckId} updated`,

  })

  return result
}

export async function deleteTruck(truckId: string, actorId?: string | null, ip?: string | null) {
  const result = await TruckModel.remove(truckId)

  logEvent({
    user_id:     actorId,
    log_type:    'vehicle_activity',
    action:      'vehicle_deleted',
    description: `Vehicle ${truckId} deleted`,

  })

  return result
}
