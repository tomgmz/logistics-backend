import type { PoolClient } from 'pg'
import { pool } from './database.js'

/**
 * Runs `fn` inside one transaction holding the booking's row lock.
 *
 * The writes that decide who is driving a booking — staff (re)assigning the
 * crew, and the driver starting the delivery — each read the booking and then
 * change it. Done as separate supabase-js calls, two of them could interleave:
 * a driver's start passes the crew check, the office swaps the crew, and the
 * start lands on a booking it no longer belongs to (BK-202610-00012, 17 Oct:
 * loaded at 04:33:31, re-crewed 46 s later and pushed back to 'assigned').
 *
 * Every such write goes through here, so they queue on the booking row: the
 * second one waits, then reads what the first committed. Keep `fn` short — only
 * the check and the status/crew writes belong in it; notifications, audit logs
 * and Google calls run after it returns.
 *
 * `fn` must write the booking's crew and status through `client`. A supabase-js
 * write to `bookings` from inside it would wait on this very lock forever.
 */
export async function withBookingRowLock<T>(
  bookingId: string,
  fn: (client: PoolClient, booking: LockedBooking) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<LockedBooking>(
      `SELECT booking_id, status::text AS status
         FROM bookings
        WHERE booking_id = $1
          FOR UPDATE`,
      [bookingId],
    )
    if (!rows[0]) throw new Error(`Booking with ID ${bookingId} not found`)
    const result = await fn(client, rows[0])
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export interface LockedBooking {
  booking_id: string
  status:     string
}

/** The caller's seat on the booking, read inside the lock so it is current. */
export async function crewSeatFor(
  client: PoolClient,
  bookingId: string,
  userId: string,
): Promise<'lead' | 'second' | null> {
  const { rows } = await client.query<{ crew_role: 'lead' | 'second' }>(
    `SELECT da.crew_role
       FROM driver_assignments da
       JOIN drivers d ON d.driver_id = da.driver_id
      WHERE da.booking_id = $1 AND d.user_id = $2
      LIMIT 1`,
    [bookingId, userId],
  )
  return rows[0]?.crew_role ?? null
}
