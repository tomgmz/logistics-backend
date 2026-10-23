import type { PoolClient } from 'pg'
import { pool } from '../../lib/database.js'

export interface VehicleTypeRow {
  vehicle_type_id: string
  name:            string
  description:     string | null
  is_active:       boolean
  created_at:      string
  updated_at:      string
  /** Non-archived truck models carrying this type. */
  model_count:     number
}

// Models match a type by name, case- and space-insensitively, the same way the
// unique index compares names.
const MODEL_COUNT = `(
  SELECT count(*)::int FROM truck_models tm
   WHERE tm.archived_at IS NULL
     AND lower(btrim(tm.vehicle_type)) = lower(btrim(vt.name))
) AS model_count`

async function findAll(activeOnly = false): Promise<VehicleTypeRow[]> {
  const { rows } = await pool.query<VehicleTypeRow>(
    `SELECT vt.*, ${MODEL_COUNT}
       FROM vehicle_types vt
      ${activeOnly ? 'WHERE vt.is_active' : ''}
      ORDER BY lower(vt.name)`,
  )
  return rows
}

async function findById(id: string, db: Pick<PoolClient, 'query'> = pool): Promise<VehicleTypeRow | null> {
  const { rows } = await db.query<VehicleTypeRow>(
    `SELECT vt.*, ${MODEL_COUNT} FROM vehicle_types vt WHERE vt.vehicle_type_id = $1`,
    [id],
  )
  return rows[0] ?? null
}

async function findByName(name: string): Promise<VehicleTypeRow | null> {
  const { rows } = await pool.query<VehicleTypeRow>(
    `SELECT vt.*, ${MODEL_COUNT} FROM vehicle_types vt WHERE lower(btrim(vt.name)) = lower(btrim($1))`,
    [name],
  )
  return rows[0] ?? null
}

async function create(input: { name: string; description: string | null; is_active: boolean }) {
  const { rows } = await pool.query<{ vehicle_type_id: string }>(
    `INSERT INTO vehicle_types (name, description, is_active)
     VALUES ($1, $2, $3) RETURNING vehicle_type_id`,
    [input.name, input.description, input.is_active],
  )
  return findById(rows[0].vehicle_type_id) as Promise<VehicleTypeRow>
}

/**
 * Update one type. A rename also rewrites the name on every truck model that
 * carries the old one, in the same transaction, so a model never points at a
 * type that no longer exists. Bookings and deliveries keep their snapshot.
 */
async function update(
  id: string,
  fields: { name?: string; description?: string | null; is_active?: boolean },
): Promise<{ row: VehicleTypeRow; renamedModels: number } | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [current] } = await client.query<{ name: string }>(
      'SELECT name FROM vehicle_types WHERE vehicle_type_id = $1 FOR UPDATE',
      [id],
    )
    if (!current) {
      await client.query('ROLLBACK')
      return null
    }

    const sets: string[] = []
    const values: unknown[] = []
    const add = (col: string, v: unknown) => { values.push(v); sets.push(`${col} = $${values.length}`) }
    if (fields.name        !== undefined) add('name', fields.name)
    if (fields.description !== undefined) add('description', fields.description)
    if (fields.is_active   !== undefined) add('is_active', fields.is_active)
    sets.push('updated_at = now()')
    values.push(id)
    await client.query(`UPDATE vehicle_types SET ${sets.join(', ')} WHERE vehicle_type_id = $${values.length}`, values)

    let renamedModels = 0
    if (fields.name !== undefined && fields.name !== current.name) {
      const res = await client.query(
        `UPDATE truck_models SET vehicle_type = $1
          WHERE lower(btrim(vehicle_type)) = lower(btrim($2))`,
        [fields.name, current.name],
      )
      renamedModels = res.rowCount ?? 0
    }

    const row = await findById(id, client)
    await client.query('COMMIT')
    return { row: row as VehicleTypeRow, renamedModels }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function remove(id: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM vehicle_types WHERE vehicle_type_id = $1', [id])
  return (res.rowCount ?? 0) > 0
}

export const VehicleTypeModel = { findAll, findById, findByName, create, update, remove }
