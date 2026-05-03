import { pool } from '../../lib/database.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'

const SELECT_TRUCK = `
  SELECT
    t.*,
    row_to_json(tm.*) AS truck_model
  FROM trucks t
  LEFT JOIN truck_models tm ON tm.model_id = t.model_id
`

export interface TruckListQuery {
  page:     number
  limit:    number
  status?:  string | null
  owned_by?: string | null
  search?:  string | null
}

async function findAllPaginated(q: TruckListQuery) {
  const page   = Math.max(1, q.page)
  const limit  = Math.min(Math.max(1, q.limit), 100)
  const offset = (page - 1) * limit

  const status  = (q.status ?? 'all').trim().toLowerCase()
  const ownedBy = (q.owned_by ?? 'all').trim().toLowerCase()
  const search  = (q.search ?? '').trim()

  const params: unknown[] = []
  const where: string[] = []

  if (status === 'archived') {
    where.push(`t.status = 'archived'`)
  } else {
    where.push(`t.status != 'archived'`)
    if (status !== 'all') {
      params.push(status)
      where.push(`t.status = $${params.length}`)
    }
  }

  if (ownedBy === 'company' || ownedBy === 'vendor') {
    params.push(ownedBy)
    where.push(`t.owned_by = $${params.length}`)
  }

  if (search) {
    const esc = `%${search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    params.push(esc)
    const i = params.length
    where.push(`(
      t.plate_number ILIKE $${i} ESCAPE '\\' OR
      t.truck_type ILIKE $${i} ESCAPE '\\' OR
      t.truck_id::text ILIKE $${i} ESCAPE '\\' OR
      COALESCE(tm.name, '') ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const countResult = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM trucks t LEFT JOIN truck_models tm ON tm.model_id = t.model_id ${whereSql}`,
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

async function create(input: CreateTruckInput) {
  const result = await pool.query(
    `INSERT INTO trucks (plate_number, truck_type, model_id, owned_by, vendor_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      input.plate_number,
      input.truck_type,
      input.model_id ?? null,
      input.owned_by,
      input.vendor_id ?? null,
    ]
  )

  return findById(result.rows[0].truck_id)
}

async function update(truckId: string, input: UpdateTruckInput) {
  const fields: string[] = []
  const values: any[] = []
  let index = 1

  if (input.plate_number !== undefined) { fields.push(`plate_number = $${index++}`)  ; values.push(input.plate_number) }
  if (input.truck_type   !== undefined) { fields.push(`truck_type = $${index++}`)     ; values.push(input.truck_type) }
  if (input.model_id     !== undefined) { fields.push(`model_id = $${index++}`)       ; values.push(input.model_id) }
  if (input.status       !== undefined) { fields.push(`status = $${index++}`)         ; values.push(input.status) }
  if (input.owned_by     !== undefined) { fields.push(`owned_by = $${index++}`)       ; values.push(input.owned_by) }
  if (input.vendor_id    !== undefined) { fields.push(`vendor_id = $${index++}`)      ; values.push(input.vendor_id) }

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

export { findAll, findAllPaginated, findById, create, update, remove }