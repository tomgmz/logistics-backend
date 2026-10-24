import { pool } from '../../lib/database.js'

/*
 * Booking mentions in Messages ("@BK-202610-00033").
 *
 * A message only ever stores the booking number as text; who may see a
 * booking's details is decided here, per reader, every time:
 *
 *   - a client: their own bookings
 *   - a driver: bookings they are crewed on (main or second driver) in full;
 *     any other booking mentioned in a chat or group they are in as a short
 *     card (number, status, schedule), never the client, places or crew
 *   - staff: every booking
 *
 * Otherwise the reader sees only the number. The short card needs the number
 * to really be in one of the driver's chats, so typing numbers into the
 * request can't look up bookings nobody showed them.
 */

export interface MentionViewer {
  userId:   string
  role:     string
  clientId: string | null
  driverId: string | null
}

export interface MentionableBooking {
  booking_id:       string
  reference_number: string
  status:           string
  company_name:     string | null
  schedule_date:    string | null
}

export interface BookingMentionDetails extends MentionableBooking {
  call_time: string | null
  origin:    string | null
  drop_offs: string[]
  vehicle:   string | null
  drivers:   string[]
  /** A driver's short card: only number, status and schedule are filled in. */
  limited?:  boolean
}

/** The WHERE fragment that limits `b` to what the viewer may read. */
function scopeSql(viewer: MentionViewer, params: unknown[]): string | null {
  if (viewer.role === 'client') {
    if (!viewer.clientId) return null
    params.push(viewer.clientId)
    return `b.client_id = $${params.length}`
  }
  if (viewer.role === 'driver') {
    if (!viewer.driverId) return null
    params.push(viewer.driverId)
    return `EXISTS (SELECT 1 FROM driver_assignments da WHERE da.booking_id = b.booking_id AND da.driver_id = $${params.length})`
  }
  return 'TRUE'
}

/** The bookings offered after "@", newest first; `q` narrows by number or company. */
export async function searchMentionable(viewer: MentionViewer, q: string, limit = 20): Promise<MentionableBooking[]> {
  const params: unknown[] = []
  const scope = scopeSql(viewer, params)
  if (!scope) return []

  const where = ['b.reference_number IS NOT NULL', scope]
  const term  = q.trim()
  if (term) {
    params.push(`%${term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`)
    const i = params.length
    where.push(`(b.reference_number ILIKE $${i} ESCAPE '\\' OR COALESCE(c.company_name, '') ILIKE $${i} ESCAPE '\\')`)
  }
  params.push(limit)

  const { rows } = await pool.query<MentionableBooking>(
    `SELECT b.booking_id, b.reference_number, b.status::text AS status, c.company_name,
            b.schedule_date::text AS schedule_date
       FROM bookings b
       LEFT JOIN clients c ON c.client_id = b.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at DESC
      LIMIT $${params.length}`,
    params,
  )
  return rows
}

/** The details card for each mentioned number the viewer may read; others are left out. */
export async function findMentionDetails(viewer: MentionViewer, refs: string[]): Promise<BookingMentionDetails[]> {
  if (!refs.length) return []
  const params: unknown[] = [refs]
  const scope = scopeSql(viewer, params)
  if (!scope) return []

  const { rows } = await pool.query<BookingMentionDetails>(
    `SELECT b.booking_id, b.reference_number, b.status::text AS status, c.company_name,
            b.schedule_date::text AS schedule_date, b.call_time::text AS call_time, b.origin,
            COALESCE((SELECT array_agg(bd.address ORDER BY bd.sequence_order)
                        FROM booking_destinations bd WHERE bd.booking_id = b.booking_id), '{}') AS drop_offs,
            (SELECT CASE
                      WHEN d.is_vendor_supplied THEN NULLIF(concat_ws(' · ', d.vendor_vehicle_plate, d.vendor_vehicle_type), '')
                      ELSE NULLIF(concat_ws(' · ', t.plate_number, tm.vehicle_type), '')
                    END
               FROM deliveries d
               LEFT JOIN trucks t        ON t.truck_id  = d.truck_id
               LEFT JOIN truck_models tm ON tm.model_id = t.model_id
              WHERE d.booking_id = b.booking_id
              ORDER BY d.created_at DESC
              LIMIT 1) AS vehicle,
            COALESCE((SELECT array_agg(trim(concat_ws(' ', u.first_name, u.last_name))
                                       ORDER BY (da.crew_role = 'second'), da.assigned_at)
                        FROM driver_assignments da
                        JOIN drivers dr ON dr.driver_id = da.driver_id
                        JOIN users u    ON u.user_id    = dr.user_id
                       WHERE da.booking_id = b.booking_id), '{}') AS drivers
       FROM bookings b
       LEFT JOIN clients c ON c.client_id = b.client_id
      WHERE b.reference_number = ANY($1::text[]) AND ${scope}`,
    params,
  )
  if (viewer.role !== 'driver' || !viewer.driverId) return rows

  const rest = refs.filter(r => !rows.some(b => b.reference_number === r))
  if (!rest.length) return rows
  const short = await pool.query<{ reference_number: string; status: string; schedule_date: string | null; call_time: string | null }>(
    `SELECT b.reference_number, b.status::text AS status, b.schedule_date::text AS schedule_date, b.call_time::text AS call_time
       FROM bookings b
      WHERE b.reference_number = ANY($1::text[])
        AND (
          EXISTS (SELECT 1 FROM messages m
                    JOIN conversations c ON c.conversation_id = m.conversation_id
                   WHERE $2 IN (c.participant_a_id, c.participant_b_id)
                     AND m.content ILIKE '%' || b.reference_number || '%')
          OR EXISTS (SELECT 1 FROM group_messages gm
                       JOIN group_members gmb ON gmb.group_id = gm.group_id
                      WHERE gmb.user_id = $2 AND gmb.status = 'accepted'
                        AND gm.content ILIKE '%' || b.reference_number || '%')
        )`,
    [rest, viewer.userId],
  )
  return [
    ...rows,
    ...short.rows.map(b => ({
      // The internal id stays private; the number is enough to key the card.
      booking_id: b.reference_number, reference_number: b.reference_number, status: b.status,
      schedule_date: b.schedule_date, call_time: b.call_time,
      company_name: null, origin: null, drop_offs: [], vehicle: null, drivers: [], limited: true,
    })),
  ]
}
