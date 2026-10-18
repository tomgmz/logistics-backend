/**
 * Walks a crew replacement end to end on a QA booking, then puts it all back.
 *
 *   SUPPRESS_NOTIFICATIONS=1 npx tsx scripts/verify-crew-replacement.ts <bookingId> <altDriverId> <altTruckId>
 *
 * The booking must be 'assigned' with a pending first trip and a company lead
 * driver. Notifications must be suppressed (the script refuses otherwise): the
 * services run for real against the live database. Everything touched — the
 * booking, its delivery, crew, trips, pauses, replacements, the drivers' and
 * vehicles' statuses and this run's audit log rows — is restored at the end.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import { claimDeliveryStart } from '../src/services/driver/start-delivery.service.js'
import {
  replaceCrewService,
  driverConfirmLoadTransferService,
  driverPendingLoadTransferService,
} from '../src/services/admin/crew-replacement.service.js'
import { assertNoPendingLoadTransfer } from '../src/services/driver/crew-actor.js'
import { AssignmentModel } from '../src/models/admin/assignment.model.js'

if (process.env.SUPPRESS_NOTIFICATIONS !== '1') {
  console.error('Run with SUPPRESS_NOTIFICATIONS=1 — this script calls services that notify real people.')
  process.exit(1)
}
const [bookingId, altDriverId, altTruckId] = process.argv.slice(2)
if (!bookingId || !altDriverId || !altTruckId) {
  console.error('usage: SUPPRESS_NOTIFICATIONS=1 npx tsx scripts/verify-crew-replacement.ts <bookingId> <altDriverId> <altTruckId>')
  process.exit(1)
}
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[]
// Taken from the database: audit_logs.timestamp has no zone, so a JS Date
// param would be compared against it eight hours off.
const [{ t: startedAt }] = (await pool.query(`select (now() at time zone 'utc')::text t`)).rows

// ── Snapshot ────────────────────────────────────────────────────────────────
async function cols(table: string) {
  return (await q(`select column_name from information_schema.columns
                    where table_schema = 'public' and table_name = $1
                      and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS'
                    order by ordinal_position`, [table])).map((r) => `"${r.column_name}"`).join(', ')
}
async function rowsOf(table: string, where: string, params: unknown[]) {
  return (await q(`select to_jsonb(t) j from ${table} t where ${where}`, params)).map((r) => r.j)
}
async function updateBack(table: string, pk: string, rows: any[]) {
  const c = await cols(table)
  for (const r of rows) {
    await q(`update ${table} set (${c}) = (select ${c} from jsonb_populate_record(null::${table}, $1)) where ${pk} = $2`, [r, r[pk]])
  }
}
async function replaceAll(table: string, rows: any[]) {
  const c = await cols(table)
  await q(`delete from ${table} where booking_id = $1`, [bookingId])
  for (const r of rows) await q(`insert into ${table} (${c}) select ${c} from jsonb_populate_record(null::${table}, $1)`, [r])
}

const snap = {
  booking:  await rowsOf('bookings', 'booking_id = $1', [bookingId]),
  delivery: await rowsOf('deliveries', 'booking_id = $1', [bookingId]),
  drivers:  await rowsOf('driver_assignments', 'booking_id = $1', [bookingId]),
  trucks:   await rowsOf('truck_assignments', 'booking_id = $1', [bookingId]),
  trips:    await rowsOf('booking_trips', 'booking_id = $1', [bookingId]),
}
const b0 = snap.booking[0]
if (!b0 || b0.status !== 'assigned') throw new Error('booking must exist and be assigned')
const lead      = snap.drivers.find((r: any) => r.crew_role === 'lead')
const origTruck = snap.trucks[0]?.truck_id
const trip      = [...snap.trips].sort((a: any, b: any) => a.trip_number - b.trip_number)[0]
if (!lead || !origTruck || !trip || trip.status !== 'pending') throw new Error('need a lead driver, a truck and a pending first trip')
const fleetDrivers = await rowsOf('drivers', 'driver_id = any($1)', [[lead.driver_id, altDriverId]])
const fleetTrucks  = await rowsOf('trucks', 'truck_id = any($1)', [[origTruck, altTruckId]])
const [oldUser] = await q(`select user_id from drivers where driver_id = $1`, [lead.driver_id])
const [newUser] = await q(`select user_id from drivers where driver_id = $1`, [altDriverId])
// Pass the current lead as altDriverId to replace only the vehicle.
const driverSwap = altDriverId !== lead.driver_id
const [staff]   = await q(`select user_id from users where role = 'admin' and coalesce(status, 'active') = 'active' limit 1`)
const oldActor  = { userId: oldUser.user_id as string, role: 'driver' }
const newActor  = { userId: newUser.user_id as string, role: 'driver' }
const staffActor = { userId: (staff?.user_id ?? null) as string | null, role: 'admin' }

async function restore() {
  await q(`delete from crew_replacements where booking_id = $1`, [bookingId])
  await q(`delete from booking_pauses where booking_id = $1 and created_at >= ($2::timestamp at time zone 'utc')`, [bookingId, startedAt])
  await updateBack('bookings', 'booking_id', snap.booking)
  await updateBack('deliveries', 'delivery_id', snap.delivery)
  await updateBack('booking_trips', 'trip_id', snap.trips)
  await replaceAll('driver_assignments', snap.drivers)
  await replaceAll('truck_assignments', snap.trucks)
  await updateBack('drivers', 'driver_id', fleetDrivers)
  await updateBack('trucks', 'truck_id', fleetTrucks)
  await q(`delete from audit_logs where timestamp >= $1::timestamp and description ilike $2`, [startedAt, `%${b0.reference_number}%`])
}

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null } catch (e) { return (e as Error).message }
}
const replaceInput = { driver_id: altDriverId, truck_id: altTruckId, reason_note: 'QA: vehicle broke down' }

try {
  console.log('\nBefore the start')
  check('replacing an assigned (not started) booking is refused',
    !!(await refused(() => replaceCrewService(bookingId, replaceInput, staffActor))))

  console.log('\nStarted and loaded, not paused')
  await claimDeliveryStart(bookingId, oldActor)
  await q(`update booking_trips set status = 'in_transit', pickup_proof_photo_url = 'https://example.invalid/qa.jpg', pickup_proof_at = now() where trip_id = $1`, [trip.trip_id])
  check('re-assigning is refused', !!(await refused(() => AssignmentModel.assign(bookingId, replaceInput as any, null))))
  check('replacing while moving is refused',
    !!(await refused(() => replaceCrewService(bookingId, replaceInput, staffActor))))

  console.log('\nPaused for a breakdown → replace driver and vehicle')
  await q(`insert into booking_pauses (booking_id, trip_id, reason, note, paused_by, latitude, longitude)
           values ($1, $2, 'vehicle_breakdown', 'QA breakdown', $3, $4, $5)`,
    [bookingId, trip.trip_id, oldUser.user_id, b0.origin_latitude, b0.origin_longitude])
  await q(`update bookings set paused_at = now(), pause_reason = 'vehicle_breakdown', pause_note = 'QA breakdown' where booking_id = $1`, [bookingId])
  const rep = await replaceCrewService(bookingId, replaceInput, staffActor)
  const [b1] = await q(`select status::text status from bookings where booking_id = $1`, [bookingId])
  const crew = await q(`select driver_id, crew_role from driver_assignments where booking_id = $1`, [bookingId])
  const [t1] = await q(`select status, pickup_proof_photo_url from booking_trips where trip_id = $1`, [trip.trip_id])
  check('booking stays in transit', b1.status === 'in_transit', b1.status)
  check(driverSwap ? 'new driver is the lead, old one gone' : 'driver kept as the lead',
    crew.length === 1 && crew[0].driver_id === altDriverId)
  check('the loaded trip and its pickup proof are kept', t1.status === 'in_transit' && !!t1.pickup_proof_photo_url)
  check('replacement recorded with the old crew', rep.old_driver_id === lead.driver_id && rep.old_truck_id === origTruck)
  check('load transfer required (loaded + vehicle changed)', rep.transfer_required === true)
  check('handover point = the pause position', rep.handover_latitude != null)

  if (driverSwap) {
    console.log('\nThe old driver after the hand-over')
    const oldStart = await refused(() => claimDeliveryStart(bookingId, oldActor))
    check('old driver is refused as not assigned', /not assigned/.test(oldStart ?? ''), oldStart ?? 'accepted')
  }

  console.log('\nThe new driver')
  const pending = await driverPendingLoadTransferService(bookingId, newActor)
  check('sees the pending transfer with the old plate', !!pending?.old_vehicle_plate, pending?.old_vehicle_plate ?? 'none')
  check('drop-offs are blocked until the transfer', !!(await refused(() => assertNoPendingLoadTransfer(bookingId))))
  check('Start/Resume is allowed (already in transit)', (await refused(() => claimDeliveryStart(bookingId, newActor))) === null)
  const noPhoto = await refused(() => driverConfirmLoadTransferService(bookingId, '', newActor, null))
  check('transfer without a photo is refused', !!noPhoto)
  const r = await driverConfirmLoadTransferService(
    bookingId, 'https://example.invalid/qa-transfer.jpg', newActor,
    { latitude: Number(b0.origin_latitude), longitude: Number(b0.origin_longitude), accuracy_m: 5 },
  )
  const [b2] = await q(`select paused_at from bookings where booking_id = $1`, [bookingId])
  check('transfer confirmed', r.confirmed === true)
  check('drop-offs unblocked', (await refused(() => assertNoPendingLoadTransfer(bookingId))) === null)
  check('the pause ended with the transfer', b2.paused_at === null)

  console.log('\nFleet state')
  const [nd] = await q(`select status from drivers where driver_id = $1`, [altDriverId])
  const [od] = await q(`select status from drivers where driver_id = $1`, [lead.driver_id])
  const [ot] = await q(`select status from trucks where truck_id = $1`, [origTruck])
  const [nt] = await q(`select status from trucks where truck_id = $1`, [altTruckId])
  check('lead driver reserved', nd.status === 'assigned', nd.status)
  if (driverSwap) check('old driver released', od.status === 'available', od.status)
  check('old vehicle left as it was (Fleet Manager decides)', ot.status === fleetTrucks.find((t: any) => t.truck_id === origTruck).status, ot.status)
  check('new vehicle in use', nt.status === 'in_use', nt.status)

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`)
} finally {
  await restore()
  const [b] = await q(`select status::text status, paused_at from bookings where booking_id = $1`, [bookingId])
  const [c] = await q(`select driver_id from driver_assignments where booking_id = $1 and crew_role = 'lead'`, [bookingId])
  const [n] = await q(`select count(*)::int n from crew_replacements where booking_id = $1`, [bookingId])
  console.log(`restored: status=${b.status} paused=${!!b.paused_at} lead=${c?.driver_id === lead.driver_id ? 'original' : 'WRONG'} replacements=${n.n}`)
  await pool.end()
}
