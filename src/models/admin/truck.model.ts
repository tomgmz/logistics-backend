import { pool } from '../../lib/database.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'

// `assigned_driver` is the vehicle's regular driver, flattened to the few fields
// the fleet list shows. Joined here rather than fetched per row because the
// vehicle table renders the name in every row.
const SELECT_TRUCK = `
  SELECT
    t.*,
    tm.vehicle_type,
    tm.name AS model_name,
    row_to_json(tm.*) AS truck_model,
    CASE WHEN ad.driver_id IS NULL THEN NULL ELSE json_build_object(
      'driver_id',      ad.driver_id,
      'license_number', ad.license_number,
      'status',         ad.status,
      'first_name',     au.first_name,
      'last_name',      au.last_name
    ) END AS assigned_driver
  FROM trucks t
  LEFT JOIN truck_models tm ON tm.model_id = t.model_id
  LEFT JOIN drivers ad      ON ad.driver_id = t.assigned_driver_id
  LEFT JOIN users au        ON au.user_id   = ad.user_id
`

export interface TruckListQuery {
  page:      number
  limit:     number
  status?:   string | null
  search?:   string | null
}

async function findAllPaginated(q: TruckListQuery) {
  const page   = Math.max(1, q.page)
  const limit  = Math.min(Math.max(1, q.limit), 100)
  const offset = (page - 1) * limit

  const status  = (q.status  ?? 'all').trim().toLowerCase()
  const search  = (q.search  ?? '').trim()

  const params: unknown[] = []
  const where:  string[]  = []

  if (status === 'archived') {
    where.push(`t.status = 'archived'`)
  } else {
    where.push(`t.status != 'archived'`)
    if (status !== 'all') {
      params.push(status)
      where.push(`t.status = $${params.length}`)
    }
  }

  if (search) {
    const esc = `%${search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    params.push(esc)
    const i = params.length
    where.push(`(
      t.plate_number ILIKE $${i} ESCAPE '\\' OR
      t.truck_id::text ILIKE $${i} ESCAPE '\\' OR
      COALESCE(tm.name, '')         ILIKE $${i} ESCAPE '\\' OR
      COALESCE(tm.vehicle_type, '') ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const countResult = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n
     FROM trucks t
     LEFT JOIN truck_models tm ON tm.model_id = t.model_id
     ${whereSql}`,
    params,
  )
  const total = parseInt(countResult.rows[0]?.n ?? '0', 10) || 0

  const limitIdx  = params.length + 1
  const offsetIdx = params.length + 2
  const listResult = await pool.query(
    `${SELECT_TRUCK} ${whereSql} ORDER BY t.plate_number ASC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, limit, offset],
  )

  return { rows: listResult.rows, total }
}

async function findAll() {
  const result = await pool.query(
    `${SELECT_TRUCK} WHERE t.status != 'archived' ORDER BY t.plate_number ASC`
  )
  return result.rows
}

async function findById(truckId: string) {
  const result = await pool.query(
    `${SELECT_TRUCK} WHERE t.truck_id = $1 AND t.status != 'archived'`,
    [truckId]
  )
  return result.rows[0] ?? null
}

/** The vehicle this driver is the regular driver of, if any. */
async function findByAssignedDriver(driverId: string) {
  const result = await pool.query(
    `${SELECT_TRUCK} WHERE t.assigned_driver_id = $1 AND t.status != 'archived'`,
    [driverId],
  )
  return result.rows[0] ?? null
}

async function create(input: CreateTruckInput) {
  const result = await pool.query(
    `INSERT INTO trucks (plate_number, model_id)
     VALUES ($1, $2)
     RETURNING *`,
    [
      input.plate_number,
      input.model_id  ?? null,
    ]
  )
  return findById(result.rows[0].truck_id)
}

async function update(truckId: string, input: UpdateTruckInput) {
  const fields: string[] = []
  const values: any[]    = []
  let   index            = 1

  if (input.plate_number !== undefined) { fields.push(`plate_number = $${index++}`); values.push(input.plate_number) }
  if (input.model_id     !== undefined) { fields.push(`model_id = $${index++}`);     values.push(input.model_id) }
  if (input.status       !== undefined) { fields.push(`status = $${index++}`);       values.push(input.status) }
  // Explicit null clears the pairing — "this truck has no regular driver" is a
  // real answer, so undefined (absent) and null must not mean the same thing.
  if (input.assigned_driver_id !== undefined) {
    fields.push(`assigned_driver_id = $${index++}`)
    values.push(input.assigned_driver_id)
  }

  if (fields.length === 0) return findById(truckId)

  fields.push(`updated_at = now()`)
  values.push(truckId)

  await pool.query(
    `UPDATE trucks SET ${fields.join(', ')} WHERE truck_id = $${index}`,
    values
  )
  return findById(truckId)
}

async function remove(truckId: string) {
  const result = await pool.query(
    `UPDATE trucks SET status = 'archived' WHERE truck_id = $1 RETURNING truck_id, status`,
    [truckId]
  )
  if (result.rowCount === 0) throw new Error(`No truck found with ID: ${truckId}`)
  return true
}

export { findAll, findAllPaginated, findById, findByAssignedDriver, create, update, remove }