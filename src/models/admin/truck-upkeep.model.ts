import { pool } from '../../lib/database.js'

/**
 * Odometer readings and service records — see the
 * 20260928040000_vehicle_service_schedule migration.
 *
 * Every write that moves the odometer also moves trucks.odometer_km in the same
 * transaction, so the fleet list and the due check never disagree with the
 * history they are derived from.
 */

export type OdometerKind = 'initial' | 'pre_trip' | 'post_trip' | 'service'

export interface OdometerReadingInput {
  truck_id:       string
  reading_km:     number
  kind:           OdometerKind
  photo_url?:     string | null
  booking_id?:    string | null
  inspection_id?: string | null
  recorded_by?:   string | null
}

export interface ServiceInput {
  truck_id:     string
  /** `YYYY-MM-DD` */
  serviced_at:  string
  odometer_km:  number
  work_done:    string
  workshop?:    string | null
  receipt_url?: string | null
  recorded_by?: string | null
}

type Queryable = Pick<typeof pool, 'query'>

async function insertReadingWith(db: Queryable, input: OdometerReadingInput) {
  const { rows } = await db.query(
    `INSERT INTO truck_odometer_readings
       (truck_id, reading_km, kind, photo_url, booking_id, inspection_id, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.truck_id, input.reading_km, input.kind, input.photo_url ?? null,
      input.booking_id ?? null, input.inspection_id ?? null, input.recorded_by ?? null,
    ],
  )
  await db.query(
    `UPDATE trucks SET odometer_km = $2, odometer_recorded_at = now(), updated_at = now()
      WHERE truck_id = $1`,
    [input.truck_id, input.reading_km],
  )
  return rows[0]
}

/** Record a reading and make it the vehicle's current odometer. */
async function insertReading(input: OdometerReadingInput) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = await insertReadingWith(client, input)
    await client.query('COMMIT')
    return row
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Record a service and restart the schedule from it. A service logged at a
 * higher reading than the vehicle's current one also becomes a reading.
 */
async function insertService(input: ServiceInput, currentOdometerKm: number | null) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO truck_services
         (truck_id, serviced_at, odometer_km, work_done, workshop, receipt_url, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.truck_id, input.serviced_at, input.odometer_km, input.work_done,
        input.workshop ?? null, input.receipt_url ?? null, input.recorded_by ?? null,
      ],
    )
    await client.query(
      `UPDATE trucks
          SET last_service_at = $2, last_service_odometer_km = $3, updated_at = now()
        WHERE truck_id = $1`,
      [input.truck_id, input.serviced_at, input.odometer_km],
    )
    if (currentOdometerKm == null || input.odometer_km > currentOdometerKm) {
      await insertReadingWith(client, {
        truck_id:    input.truck_id,
        reading_km:  input.odometer_km,
        kind:        'service',
        photo_url:   input.receipt_url ?? null,
        recorded_by: input.recorded_by ?? null,
      })
    }
    await client.query('COMMIT')
    return rows[0]
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function listReadings(truckId: string, limit = 50) {
  const { rows } = await pool.query(
    `SELECT r.*, b.reference_number,
            CASE WHEN u.user_id IS NULL THEN NULL
                 ELSE json_build_object('first_name', u.first_name, 'last_name', u.last_name) END AS recorder
       FROM truck_odometer_readings r
       LEFT JOIN bookings b ON b.booking_id = r.booking_id
       LEFT JOIN users u    ON u.user_id    = r.recorded_by
      WHERE r.truck_id = $1
      ORDER BY r.recorded_at DESC
      LIMIT $2`,
    [truckId, limit],
  )
  return rows
}

async function listServices(truckId: string) {
  const { rows } = await pool.query(
    `SELECT s.*, to_char(s.serviced_at, 'YYYY-MM-DD') AS serviced_at,
            CASE WHEN u.user_id IS NULL THEN NULL
                 ELSE json_build_object('first_name', u.first_name, 'last_name', u.last_name) END AS recorder
       FROM truck_services s
       LEFT JOIN users u ON u.user_id = s.recorded_by
      WHERE s.truck_id = $1
      ORDER BY s.serviced_at DESC, s.created_at DESC`,
    [truckId],
  )
  return rows
}

/** The booking this vehicle most recently came back from, if any. */
async function lastReturnedBookingId(truckId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT b.booking_id
       FROM deliveries d
       JOIN bookings b ON b.booking_id = d.booking_id
      WHERE d.truck_id = $1 AND b.fleet_return_at IS NOT NULL
      ORDER BY b.fleet_return_at DESC
      LIMIT 1`,
    [truckId],
  )
  return rows[0]?.booking_id ?? null
}

export { insertReading, insertService, listReadings, listServices, lastReturnedBookingId }
