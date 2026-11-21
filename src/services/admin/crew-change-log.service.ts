import { pool } from '../../lib/database.js'

/**
 * Every change of driver, second driver, helper or vehicle on a booking, and
 * every navigation take-over between the two drivers' phones (2026-11-21).
 *
 * booking_crew_changes is written by a trigger on deliveries, so assignment,
 * re-assignment, replacement, swap and even a change made straight in the
 * database all land here. Shown in Booking Management ("What happened on the
 * road", via deliveryEvents) and in the Transaction History record.
 */

export type CrewSeat = 'driver' | 'second_driver' | 'helper' | 'vehicle'

export interface CrewChangeEvent {
  at:     string
  kind:   'crew_changed' | 'navigation_moved'
  title:  string
  /** One line per seat that changed, e.g. "Main driver: Juan Cruz → Pedro Reyes". */
  lines:  string[]
  reason: string | null
  by:     string | null
  by_role: string | null
}

const SEAT_LABEL: Record<CrewSeat, string> = {
  driver:        'Main driver',
  second_driver: 'Second driver',
  helper:        'Helper',
  vehicle:       'Vehicle',
}

const SOURCE_TITLE: Record<string, string> = {
  assigned:   'Driver and vehicle assigned',
  backfill:   'Driver and vehicle assigned',
  reassigned: 'Driver or vehicle changed before the start',
  replaced:   'Driver or vehicle replaced while paused',
  swapped:    'Main and second driver swapped',
  database:   'Driver or vehicle changed outside the app',
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
const fullName = (f: string | null, l: string | null) => [f, l].filter(Boolean).join(' ') || null

function lineFor(seat: CrewSeat, oldLabel: string | null, newLabel: string | null): string {
  const what = SEAT_LABEL[seat]
  if (!oldLabel && newLabel) return `${what}: ${newLabel}`
  if (oldLabel && !newLabel) return `${what} removed: ${oldLabel}`
  return `${what}: ${oldLabel ?? '—'} → ${newLabel ?? '—'}`
}

export async function crewChangeEvents(bookingId: string): Promise<CrewChangeEvent[]> {
  const [changes, claims] = await Promise.all([
    pool.query(
      `SELECT c.changed_at, c.seat, c.old_label, c.new_label, c.source, c.reason, c.changed_by_role,
              u.first_name, u.last_name
         FROM booking_crew_changes c
         LEFT JOIN users u ON u.user_id = c.changed_by
        WHERE c.booking_id = $1
        ORDER BY c.changed_at, c.seat`, [bookingId]),
    pool.query(
      `SELECT c.claimed_at, c.took_over_from,
              nu.first_name AS nf, nu.last_name AS nl, ou.first_name AS of, ou.last_name AS ol
         FROM booking_nav_claims c
         LEFT JOIN drivers nd ON nd.driver_id = c.driver_id      LEFT JOIN users nu ON nu.user_id = nd.user_id
         LEFT JOIN drivers od ON od.driver_id = c.took_over_from LEFT JOIN users ou ON ou.user_id = od.user_id
        WHERE c.booking_id = $1 AND c.took_over_from IS NOT NULL`, [bookingId]),
  ])

  // One event per write: a single assignment or replacement changes several
  // seats in one transaction, so its rows share changed_at and source.
  const out: CrewChangeEvent[] = []
  const groups = new Map<string, CrewChangeEvent>()
  for (const r of changes.rows) {
    const at  = iso(r.changed_at)!
    const key = `${at}|${r.source}`
    let ev = groups.get(key)
    if (!ev) {
      ev = {
        at,
        kind:    'crew_changed',
        title:   SOURCE_TITLE[r.source] ?? 'Driver or vehicle changed',
        lines:   [],
        reason:  r.reason ?? null,
        by:      fullName(r.first_name, r.last_name),
        by_role: r.changed_by_role ?? null,
      }
      groups.set(key, ev)
      out.push(ev)
    }
    ev.lines.push(lineFor(r.seat as CrewSeat, r.old_label ?? null, r.new_label ?? null))
  }

  for (const r of claims.rows) {
    const to   = fullName(r.nf, r.nl) ?? 'A driver'
    const from = fullName(r.of, r.ol) ?? 'the other driver'
    out.push({
      at:      iso(r.claimed_at)!,
      kind:    'navigation_moved',
      title:   `Navigation moved to ${to}'s phone`,
      lines:   [`Taken over from ${from}'s phone`],
      reason:  null,
      by:      to,
      by_role: 'driver',
    })
  }

  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** One row of the export's "Driver Changes" sheet: one seat changed, or one navigation take-over. */
export interface CrewChangeExportRow {
  booking_id:       string
  reference_number: string | null
  changed_at:       string
  change:           string
  seat:             string
  from:             string | null
  to:               string | null
  reason:           string | null
  by:               string | null
  by_role:          string | null
}

/**
 * The same changes as crewChangeEvents, flat, for many bookings at once (the
 * Transaction History export). Two queries for the whole export, not one per
 * booking. Oldest first within each booking.
 */
export async function crewChangeRowsFor(bookingIds: string[]): Promise<CrewChangeExportRow[]> {
  if (!bookingIds.length) return []
  const [changes, claims] = await Promise.all([
    pool.query(
      `SELECT c.booking_id, b.reference_number, c.changed_at, c.seat, c.old_label, c.new_label, c.source, c.reason,
              c.changed_by_role, u.first_name, u.last_name
         FROM booking_crew_changes c
         JOIN bookings b ON b.booking_id = c.booking_id
         LEFT JOIN users u ON u.user_id = c.changed_by
        WHERE c.booking_id = ANY($1::uuid[])`, [bookingIds]),
    pool.query(
      `SELECT c.booking_id, b.reference_number, c.claimed_at,
              nu.first_name AS nf, nu.last_name AS nl, ou.first_name AS of, ou.last_name AS ol
         FROM booking_nav_claims c
         JOIN bookings b ON b.booking_id = c.booking_id
         LEFT JOIN drivers nd ON nd.driver_id = c.driver_id      LEFT JOIN users nu ON nu.user_id = nd.user_id
         LEFT JOIN drivers od ON od.driver_id = c.took_over_from LEFT JOIN users ou ON ou.user_id = od.user_id
        WHERE c.booking_id = ANY($1::uuid[]) AND c.took_over_from IS NOT NULL`, [bookingIds]),
  ])

  const rows: CrewChangeExportRow[] = []
  for (const r of changes.rows) {
    rows.push({
      booking_id:       r.booking_id,
      reference_number: r.reference_number ?? null,
      changed_at:       iso(r.changed_at)!,
      change:           SOURCE_TITLE[r.source] ?? 'Driver or vehicle changed',
      seat:             SEAT_LABEL[r.seat as CrewSeat] ?? r.seat,
      from:             r.old_label ?? null,
      to:               r.new_label ?? null,
      reason:           r.reason ?? null,
      by:               fullName(r.first_name, r.last_name),
      by_role:          r.changed_by_role ?? null,
    })
  }
  for (const r of claims.rows) {
    rows.push({
      booking_id:       r.booking_id,
      reference_number: r.reference_number ?? null,
      changed_at:       iso(r.claimed_at)!,
      change:           'Navigation taken over',
      seat:             'Navigating phone',
      from:             fullName(r.of, r.ol),
      to:               fullName(r.nf, r.nl),
      reason:           null,
      by:               fullName(r.nf, r.nl),
      by_role:          'driver',
    })
  }
  // Grouped by booking in the export's order, oldest change first within each.
  const order = new Map(bookingIds.map((id, i) => [id, i]))
  return rows.sort((a, b) =>
    (order.get(a.booking_id)! - order.get(b.booking_id)!) || (Date.parse(a.changed_at) - Date.parse(b.changed_at)))
}
