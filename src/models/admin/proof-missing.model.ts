import { pool } from '../../lib/database.js'

/**
 * "Proof missing" on a drop-off (2026-11-27).
 *
 * A drop-off has no proof when one of its visits was recorded delivered without
 * a photo (the office's "Complete for the driver", or a driver whose photo never
 * arrived) and no Proof of Delivery is linked to it (non-archived; uploads count
 * at once since 2026-11-27, no review; an older rejected one does not count).
 *
 * Worked out from the rows every time, never stored: a photo the driver sends
 * later, an upload or an archive changes it at once, with nothing to keep in
 * step.
 */

export type DropoffProofState = 'missing' | null

export interface DropoffProofRow {
  destination_id: string
  sequence_order: number
  address:        string
  status:         string
  proof_state:    DropoffProofState
}

const NO_PHOTO_SQL = `
  EXISTS (SELECT 1 FROM booking_trip_stops s
           WHERE s.destination_id = bd.destination_id
             AND s.status = 'delivered'
             AND s.proof_photo_url IS NULL)`

const POD_SQL = `
  EXISTS (SELECT 1 FROM documents d
           WHERE d.destination_id = bd.destination_id
             AND d.document_type = 'proof_of_delivery'
             AND d.archived_at IS NULL
             AND d.status = 'approved')`

/** Every drop-off of one booking, in route order, with its proof state. */
export async function findDropoffProof(bookingId: string): Promise<DropoffProofRow[]> {
  const { rows } = await pool.query<DropoffProofRow & { no_photo: boolean; has_pod: boolean }>(
    `SELECT bd.destination_id, bd.sequence_order, bd.address, bd.status,
            ${NO_PHOTO_SQL} AS no_photo,
            ${POD_SQL}      AS has_pod
       FROM booking_destinations bd
      WHERE bd.booking_id = $1::uuid
      ORDER BY bd.sequence_order ASC`,
    [bookingId],
  )
  return rows.map(({ no_photo, has_pod, ...r }) => ({
    ...r,
    proof_state: no_photo && !has_pod ? 'missing' : null,
  }))
}

/** The one drop-off of a booking, or null when it has none or several. */
export async function findOnlyDestination(bookingId: string): Promise<string | null> {
  const { rows } = await pool.query<{ destination_id: string }>(
    `SELECT destination_id FROM booking_destinations WHERE booking_id = $1::uuid LIMIT 2`,
    [bookingId],
  )
  return rows.length === 1 ? rows[0].destination_id : null
}

export async function destinationOnBooking(destinationId: string, bookingId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM booking_destinations WHERE destination_id = $1::uuid AND booking_id = $2::uuid`,
    [destinationId, bookingId],
  )
  return rows.length > 0
}

export interface ProofReminderRow {
  booking_id:        string
  destination_id:    string
  proof_reminded_at: string | null
}

/**
 * Drop-offs still without proof, delivered before `deliveredBefore` (the start
 * of today in Manila: the paper comes back with the truck, so the first
 * reminder is the next office morning). Cancelled bookings are left out.
 */
export async function findProofMissingForReminder(deliveredBefore: Date): Promise<ProofReminderRow[]> {
  const { rows } = await pool.query<ProofReminderRow>(
    `SELECT bd.booking_id, bd.destination_id, bd.proof_reminded_at
       FROM booking_destinations bd
       JOIN bookings b ON b.booking_id = bd.booking_id
      WHERE b.status NOT IN ('cancelled')
        AND EXISTS (SELECT 1 FROM booking_trip_stops s
                     WHERE s.destination_id = bd.destination_id
                       AND s.status = 'delivered'
                       AND s.proof_photo_url IS NULL
                       AND s.delivered_at < $1)
        AND NOT ${POD_SQL}`,
    [deliveredBefore.toISOString()],
  )
  return rows
}

/** Stamp the reminder, only where nobody stamped it since `since` (two servers, one notice). */
export async function stampProofReminded(destinationIds: string[], at: Date, since: Date): Promise<number> {
  if (destinationIds.length === 0) return 0
  const { rowCount } = await pool.query(
    `UPDATE booking_destinations
        SET proof_reminded_at = $2
      WHERE destination_id = ANY($1::uuid[])
        AND (proof_reminded_at IS NULL OR proof_reminded_at < $3)`,
    [destinationIds, at.toISOString(), since.toISOString()],
  )
  return rowCount ?? 0
}
