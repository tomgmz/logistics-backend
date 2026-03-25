import { pool } from '../../lib/database.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'

const SELECT_TRUCK = `
  SELECT
    t.*,
    row_to_json(tm.*) AS truck_model
  FROM trucks t
  LEFT JOIN truck_models tm ON tm.model_id = t.model_id
`

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
    `INSERT INTO trucks (plate_number, truck_type, capacity_tons, model_id, owned_by, subcontractor_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.plate_number,
      input.truck_type,
      input.capacity_tons,
      input.model_id         ?? null,
      input.owned_by,
      input.subcontractor_id ?? null,
    ]
  )

  await pool.query(
    `INSERT INTO system_logs (user_id, log_type, action, description)
     VALUES ($1, $2, $3, $4)`,
    [
      input.created_by ?? null,
      'truck_activity',
      'truck_creation',
      `Truck ${input.plate_number} created.`,
    ]
  )

  return findById(result.rows[0].truck_id)
}

async function update(truckId: string, input: UpdateTruckInput) {
  const fields: string[] = []
  const values: any[] = []
  let index = 1

  if (input.plate_number     !== undefined) { fields.push(`plate_number = $${index++}`)     ; values.push(input.plate_number) }
  if (input.truck_type       !== undefined) { fields.push(`truck_type = $${index++}`)        ; values.push(input.truck_type) }
  if (input.capacity_tons    !== undefined) { fields.push(`capacity_tons = $${index++}`)     ; values.push(input.capacity_tons) }
  if (input.model_id         !== undefined) { fields.push(`model_id = $${index++}`)          ; values.push(input.model_id) }
  if (input.status           !== undefined) { fields.push(`status = $${index++}`)            ; values.push(input.status) }
  if (input.owned_by         !== undefined) { fields.push(`owned_by = $${index++}`)          ; values.push(input.owned_by) }
  if (input.subcontractor_id !== undefined) { fields.push(`subcontractor_id = $${index++}`)  ; values.push(input.subcontractor_id) }

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

export { findAll, findById, create, update, remove }