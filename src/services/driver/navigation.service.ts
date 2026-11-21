import { pool } from '../../lib/database.js'
import { broadcast } from '../../lib/realtime.js'
import { logEvent } from '../../lib/log-event.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { driverSeatOnBooking, type DriverActor } from '../client/booking.service.js'
import { driverIdOf } from './crew-actor.js'

/**
 * Which crew member's phone is navigating a booking (2026-11-21).
 *
 * The main and the second driver have the same buttons, but only ONE phone
 * navigates at a time. That phone is also the truck's live position on the
 * client's map (tracking.service). Industry: Samsara / Motive / Garmin eLog
 * team driving keep one active device or driver per vehicle with an explicit
 * switch; Google bills the Navigation SDK per route request, so two phones
 * guiding the same truck would pay twice and put two trucks on the map.
 *
 *   - Opening navigation claims it (POST /driver/bookings/:id/navigation).
 *   - If the other driver's phone holds it, the server answers 409 with their
 *     name; the app asks "Take over?" and re-sends with take_over. No approval
 *     from the other phone is needed: it may be dead, which is the point.
 *   - The take-over is kept (booking_nav_claims) and in the audit log; the
 *     other phone hears it on route:booking:<id> and stops guiding.
 *   - Ending navigation releases it; a crew replacement ends it for a driver
 *     taken off; the vehicle's return ends it.
 */

/** A navigating phone not heard from for this long shows as "not heard from". */
export const NAV_FRESH_MS = 2 * 60_000

export interface NavigatorState {
  driver_id:     string | null
  driver_name:   string | null
  since:         string | null
  last_heard_at: string | null
  /** Whether the navigating phone has been heard from in the last 2 minutes. */
  fresh:         boolean
  mine:          boolean
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)

function announce(bookingId: string): void {
  void broadcast(`route:booking:${bookingId}`, 'route_changed', { booking_id: bookingId, kind: 'navigator' }).catch(() => {})
}

/** The open claim for a booking, with when its phone was last heard from. */
export async function navigatorOf(bookingId: string): Promise<{ driver_id: string; claimed_at: string; last_heard_at: string | null } | null> {
  const { rows: [r] } = await pool.query(
    `SELECT c.driver_id, c.claimed_at,
            (SELECT l.updated_at FROM driver_locations l WHERE l.driver_id = c.driver_id AND l.booking_id = c.booking_id) AS heard
       FROM booking_nav_claims c
      WHERE c.booking_id = $1 AND c.ended_at IS NULL`,
    [bookingId],
  )
  if (!r) return null
  return { driver_id: r.driver_id, claimed_at: iso(r.claimed_at)!, last_heard_at: iso(r.heard) }
}

async function stateFor(bookingId: string, myDriverId: string | null): Promise<NavigatorState> {
  const nav = await navigatorOf(bookingId)
  if (!nav) return { driver_id: null, driver_name: null, since: null, last_heard_at: null, fresh: false, mine: false }
  const { rows: [u] } = await pool.query(
    `SELECT u.first_name, u.last_name FROM drivers d JOIN users u ON u.user_id = d.user_id WHERE d.driver_id = $1`,
    [nav.driver_id],
  )
  const heard = Math.max(Date.parse(nav.claimed_at), nav.last_heard_at ? Date.parse(nav.last_heard_at) : 0)
  return {
    driver_id:     nav.driver_id,
    driver_name:   [u?.first_name, u?.last_name].filter(Boolean).join(' ') || null,
    since:         nav.claimed_at,
    last_heard_at: nav.last_heard_at,
    fresh:         Date.now() - heard < NAV_FRESH_MS,
    mine:          nav.driver_id === myDriverId,
  }
}

/** On the road for this booking: started, or done and still driving back to the yard. */
function onTheRoad(booking: { status: string; fleet_return_at?: string | null }): boolean {
  if (booking.status === 'assigned' || booking.status === 'in_transit') return true
  return (booking.status === 'delivered' || booking.status === 'completed' || booking.status === 'failed') && !booking.fleet_return_at
}

export async function getNavigationService(bookingId: string, actor: DriverActor): Promise<NavigatorState> {
  await driverSeatOnBooking(bookingId, actor)
  return stateFor(bookingId, await driverIdOf(actor))
}

export class NavigationHeldError extends Error {
  constructor(public readonly state: NavigatorState) {
    super(`${state.driver_name ?? 'The other driver'}'s phone is navigating this delivery`)
  }
}

/**
 * This phone starts (or keeps) navigating. Another crew member's phone holding
 * it is refused with NavigationHeldError unless `takeOver`, which the app sends
 * only after the driver confirmed. One transaction with the claim row locked,
 * so two phones claiming at once end with exactly one navigator.
 */
export async function claimNavigationService(bookingId: string, actor: DriverActor, takeOver: boolean): Promise<NavigatorState> {
  const { booking } = await driverSeatOnBooking(bookingId, actor)
  const me = await driverIdOf(actor)
  if (!me) throw new Error('You are not assigned to this booking')
  if (!onTheRoad(booking as any)) throw new Error('Cannot navigate: this delivery is not on the road')

  let tookFrom: string | null = null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialises claims per booking without holding a row that does not exist yet.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('nav:' || $1))`, [bookingId])
    // Still on the crew, read inside the lock (a replacement may have just landed).
    const { rows: [seat] } = await client.query(
      `SELECT 1 FROM driver_assignments WHERE booking_id = $1 AND driver_id = $2`, [bookingId, me])
    if (!seat) throw new Error('You are not assigned to this booking')

    const { rows: [open] } = await client.query(
      `SELECT claim_id, driver_id FROM booking_nav_claims WHERE booking_id = $1 AND ended_at IS NULL FOR UPDATE`, [bookingId])
    if (open?.driver_id === me) {
      await client.query('COMMIT')
      return stateFor(bookingId, me)
    }
    if (open) {
      if (!takeOver) {
        await client.query('ROLLBACK')
        throw new NavigationHeldError(await stateFor(bookingId, me))
      }
      await client.query(
        `UPDATE booking_nav_claims SET ended_at = now(), end_reason = 'taken_over' WHERE claim_id = $1`, [open.claim_id])
      tookFrom = open.driver_id
    }
    await client.query(
      `INSERT INTO booking_nav_claims (booking_id, driver_id, took_over_from) VALUES ($1, $2, $3)`,
      [bookingId, me, tookFrom])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  if (tookFrom) {
    const state = await stateFor(bookingId, me)
    const { rows: [old] } = await pool.query(
      `SELECT u.first_name, u.last_name FROM drivers d JOIN users u ON u.user_id = d.user_id WHERE d.driver_id = $1`, [tookFrom])
    logEvent({
      user_id:     actor.userId,
      log_type:    'booking',
      action:      'navigation_taken_over',
      description:
        `${state.driver_name ?? 'A driver'} took over navigation of booking ${bookingRef(booking)} ` +
        `from ${[old?.first_name, old?.last_name].filter(Boolean).join(' ') || 'the other driver'}'s phone`,
    })
  }
  announce(bookingId)
  return stateFor(bookingId, me)
}

/** This phone stopped navigating (the driver ended it). Only its own claim. */
export async function releaseNavigationService(bookingId: string, actor: DriverActor): Promise<NavigatorState> {
  await driverSeatOnBooking(bookingId, actor)
  const me = await driverIdOf(actor)
  if (me) {
    const { rowCount } = await pool.query(
      `UPDATE booking_nav_claims SET ended_at = now(), end_reason = 'released'
        WHERE booking_id = $1 AND driver_id = $2 AND ended_at IS NULL`, [bookingId, me])
    if (rowCount) announce(bookingId)
  }
  return stateFor(bookingId, me)
}

/** A crew replacement took these drivers off: their phone no longer navigates. */
export async function endNavigationFor(bookingId: string, driverIds: (string | null)[], reason: 'removed'): Promise<void> {
  const ids = driverIds.filter((x): x is string => !!x)
  if (!ids.length) return
  const { rowCount } = await pool.query(
    `UPDATE booking_nav_claims SET ended_at = now(), end_reason = $3
      WHERE booking_id = $1 AND driver_id = ANY($2::uuid[]) AND ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM driver_assignments da WHERE da.booking_id = $1 AND da.driver_id = booking_nav_claims.driver_id)`,
    [bookingId, ids, reason])
  if (rowCount) announce(bookingId)
}

/** The vehicle is back at the yard: nobody navigates this booking any more. */
export async function endAllNavigation(bookingId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE booking_nav_claims SET ended_at = now(), end_reason = 'returned' WHERE booking_id = $1 AND ended_at IS NULL`,
    [bookingId])
  if (rowCount) announce(bookingId)
}
