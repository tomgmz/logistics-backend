/**
 * Stop times (arrival at parking, docking, start, finish, departure) on a QA
 * booking, then puts everything back.
 *
 *   SUPPRESS_NOTIFICATIONS=1 npx tsx scripts/verify-stop-milestones.ts <bookingId>
 *
 * The booking must be 'assigned' with a pending first trip and a company lead
 * driver. Restores the booking, its delivery and trips, and deletes this run's
 * milestones and audit rows.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import { claimDeliveryStart } from '../src/services/driver/start-delivery.service.js'
import {
  bookingTimeline,
  driverRecordMilestoneService,
  staffSetMilestoneService,
} from '../src/services/client/milestone.service.js'

if (process.env.SUPPRESS_NOTIFICATIONS !== '1') {
  console.error('Run with SUPPRESS_NOTIFICATIONS=1.')
  process.exit(1)
}
const [bookingId] = process.argv.slice(2)
if (!bookingId) { console.error('usage: … <bookingId>'); process.exit(1) }
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[]
// Taken from the database: audit_logs.timestamp has no zone, so a JS Date
// param would be compared against it eight hours off.
const [{ t: startedAt }] = (await pool.query(`select (now() at time zone 'utc')::text t`)).rows

async function cols(table: string) {
  return (await q(`select column_name from information_schema.columns
                    where table_schema = 'public' and table_name = $1
                      and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS'
                    order by ordinal_position`, [table])).map((r) => `"${r.column_name}"`).join(', ')
}
const rowsOf = async (table: string) => (await q(`select to_jsonb(t) j from ${table} t where booking_id = $1`, [bookingId])).map((r) => r.j)
async function updateBack(table: string, pk: string, rows: any[]) {
  const c = await cols(table)
  for (const r of rows) await q(`update ${table} set (${c}) = (select ${c} from jsonb_populate_record(null::${table}, $1)) where ${pk} = $2`, [r, r[pk]])
}

const snap = { booking: await rowsOf('bookings'), delivery: await rowsOf('deliveries'), trips: await rowsOf('booking_trips') }
const b0 = snap.booking[0]
if (!b0 || b0.status !== 'assigned') throw new Error('booking must be assigned')
const trip = [...snap.trips].sort((a: any, b: any) => a.trip_number - b.trip_number)[0]
const [lead] = await q(`select d.user_id from driver_assignments da join drivers d using (driver_id) where da.booking_id = $1 and da.crew_role = 'lead'`, [bookingId])
const [stop] = await q(`select trip_stop_id from booking_trip_stops where trip_id = $1 order by sequence_order limit 1`, [trip.trip_id])
const actor = { userId: lead.user_id as string, role: 'driver' }
const [staff] = await q(`select user_id from users where role = 'admin' limit 1`)

async function restore() {
  await q(`delete from stop_milestones where booking_id = $1`, [bookingId])
  await updateBack('bookings', 'booking_id', snap.booking)
  await updateBack('deliveries', 'delivery_id', snap.delivery)
  await updateBack('booking_trips', 'trip_id', snap.trips)
  await q(`delete from audit_logs where timestamp >= $1::timestamp and description ilike $2`, [startedAt, `%${b0.reference_number}%`])
}

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (e) { return (e as Error).message } }
const tap = (stage: string, extra: Record<string, unknown> = {}) =>
  driverRecordMilestoneService(bookingId, { stage, trip_id: trip.trip_id, ...extra }, actor)

try {
  console.log('\nBefore the start')
  check('a tap before the delivery started is refused', !!(await refused(() => tap('arrived_parking'))))

  await claimDeliveryStart(bookingId, actor)

  console.log('\nLoading')
  const phoneWrong = new Date(Date.now() + 3 * 3600_000).toISOString()   // phone 3 h ahead, sent live
  const a = await tap('arrived_parking', { at: phoneWrong })
  check('a live tap uses the server clock, not a wrong phone clock', Math.abs(Date.parse(a.at) - Date.now()) < 10_000, a.at)
  const again = await tap('arrived_parking')
  check('re-sending the same step is harmless (first tap wins)', again.recorded === false)
  const queuedAt = new Date(Date.now() - 10 * 60_000).toISOString()  // queued offline 10 min ago
  const d = await tap('docked', { at: queuedAt })
  check('a queued tap is clamped to not before the step before it', Date.parse(d.at) >= Date.parse(a.at), d.at)
  await tap('started')
  check('departure before the loading is confirmed is refused', /Confirm the pickup/.test((await refused(() => tap('departed'))) ?? ''))
  await q(`update booking_trips set status = 'in_transit', pickup_proof_photo_url = 'https://example.invalid/qa.jpg', pickup_proof_at = now() where trip_id = $1`, [trip.trip_id])
  await q(`update booking_trip_cargo set loaded_qty = planned_qty where trip_id = $1`, [trip.trip_id])
  const dep = await tap('departed')
  check('departure after the loading is confirmed', dep.recorded === true)

  console.log('\nUnloading at the first drop-off')
  await tap('arrived_parking', { trip_stop_id: stop.trip_stop_id })
  check('the drop-off has its own steps', (await tap('docked', { trip_stop_id: stop.trip_stop_id })).recorded === true)

  console.log('\nStaff corrections')
  const t1 = await bookingTimeline(bookingId)
  const loadingArr = Date.parse(t1[0].loading.arrived_parking!.at)
  check('correction after the next step is refused', !!(await refused(() => staffSetMilestoneService(bookingId,
    { trip_id: trip.trip_id, stage: 'arrived_parking', at: new Date(Date.now() + 30_000).toISOString(), note: 'QA' }, { userId: staff.user_id }))))
  check('correction in the future is refused', !!(await refused(() => staffSetMilestoneService(bookingId,
    { trip_id: trip.trip_id, stage: 'arrived_parking', at: new Date(Date.now() + 3600_000).toISOString(), note: 'QA' }, { userId: staff.user_id }))))
  const fixed = await staffSetMilestoneService(bookingId,
    { trip_id: trip.trip_id, stage: 'arrived_parking', at: new Date(loadingArr - 20 * 60_000).toISOString(), note: 'QA: driver tapped late' },
    { userId: staff.user_id })
  check('a valid correction is saved and marked', fixed[0].loading.arrived_parking?.corrected === true && fixed[0].loading.arrived_parking?.note === 'QA: driver tapped late')
  await new Promise((r) => setTimeout(r, 1500))   // logEvent writes in the background
  const [audit] = await q(`select description from audit_logs where action = 'stop_time_corrected' and timestamp >= $1::timestamp order by timestamp desc limit 1`, [startedAt])
  check('the original time is in the audit log', !!audit && /changed from/.test(audit.description))

  console.log('\nTimeline')
  const t = await bookingTimeline(bookingId)
  const L = t[0].loading
  check('loading shows all five steps', !!(L.arrived_parking && L.docked && L.started && L.finished && L.departed))
  check('the finish is the pickup confirmation', L.finished?.source === 'proof')
  check('total loaded is shown', t[0].total_loaded != null, JSON.stringify(t[0].total_loaded))
  check('client view leaves out staff notes', (await bookingTimeline(bookingId))[0].loading.arrived_parking?.note === undefined)

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`)
} finally {
  // The cargo loaded_qty touched above goes back with the trip rows' plan:
  await q(`update booking_trip_cargo set loaded_qty = null where trip_id = $1`, [trip.trip_id])
  await restore()
  const [b] = await q(`select status::text s from bookings where booking_id = $1`, [bookingId])
  const [m] = await q(`select count(*)::int n from stop_milestones where booking_id = $1`, [bookingId])
  console.log(`restored: status=${b.s} milestones=${m.n}`)
  await pool.end()
}
