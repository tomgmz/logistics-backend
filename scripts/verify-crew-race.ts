/**
 * The race between a driver starting a delivery and staff re-assigning its crew.
 *
 *   npx tsx scripts/verify-crew-race.ts <bookingId> <altDriverId> <altTruckId> [rounds=20]
 *
 * The booking must be a QA booking in 'assigned' with a pending first trip and a
 * company lead driver; altDriverId / altTruckId are the crew the "staff" side
 * swaps in. Every row touched is snapshotted first and put back after each
 * round. No notifications are sent: the staff side calls AssignmentModel.assign
 * and the driver side calls claimDeliveryStart, the locked step Start Navigation
 * and every pickup go through.
 *
 *   R2  re-assigning an in-transit booking must be refused, crew untouched
 *   R1  start and re-assign fired together, `rounds` times: never a mixed state
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import { AssignmentModel } from '../src/models/admin/assignment.model.js'
import { claimDeliveryStart } from '../src/services/driver/start-delivery.service.js'

const [bookingId, altDriverId, altTruckId, roundsArg] = process.argv.slice(2)
if (!bookingId || !altDriverId || !altTruckId) {
  console.error('usage: npx tsx scripts/verify-crew-race.ts <bookingId> <altDriverId> <altTruckId> [rounds]')
  process.exit(1)
}
const rounds = Number(roundsArg ?? 20)
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[]

type Snap = { table: string; pk: string; rows: Record<string, any>[] }
async function snap(table: string, pk: string): Promise<Snap> {
  const rows = await q(`select to_jsonb(t) j from ${table} t where booking_id = $1`, [bookingId])
  return { table, pk, rows: rows.map((x) => x.j) }
}
async function columns(table: string): Promise<string> {
  return (await q(`select column_name from information_schema.columns
                    where table_schema = 'public' and table_name = $1
                      and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS'
                    order by ordinal_position`, [table]))
    .map((r) => `"${r.column_name}"`).join(', ')
}
async function putBack(s: Snap, replaceAll: boolean) {
  const cols = await columns(s.table)
  if (replaceAll) {
    await q(`delete from ${s.table} where booking_id = $1`, [bookingId])
    for (const r of s.rows) {
      await q(`insert into ${s.table} (${cols}) select ${cols} from jsonb_populate_record(null::${s.table}, $1)`, [r])
    }
    return
  }
  for (const r of s.rows) {
    await q(`update ${s.table} set (${cols}) = (select ${cols} from jsonb_populate_record(null::${s.table}, $1))
              where ${s.pk} = $2`, [r, r[s.pk]])
  }
}

const snaps = {
  bookings: await snap('bookings', 'booking_id'),
  delivery: await snap('deliveries', 'delivery_id'),
  drivers:  await snap('driver_assignments', 'booking_id'),
  trucks:   await snap('truck_assignments', 'booking_id'),
}
const booking = snaps.bookings.rows[0]
if (!booking) throw new Error('booking not found')
if (booking.status !== 'assigned') throw new Error(`booking must be 'assigned', is '${booking.status}'`)
const lead = snaps.drivers.rows.find((r) => r.crew_role === 'lead')
if (!lead) throw new Error('booking has no lead driver')
if (lead.driver_id === altDriverId) throw new Error('altDriverId must differ from the current lead')
const [leadUser] = await q(`select user_id from drivers where driver_id = $1`, [lead.driver_id])
const actor = { userId: leadUser.user_id as string, role: 'driver' }

async function restore() {
  await putBack(snaps.bookings, false)
  await putBack(snaps.delivery, false)
  await putBack(snaps.drivers, true)
  await putBack(snaps.trucks, true)
}
async function state() {
  const [b]  = await q(`select status::text status from bookings where booking_id = $1`, [bookingId])
  const [d]  = await q(`select status from deliveries where booking_id = $1`, [bookingId])
  const [da] = await q(`select driver_id from driver_assignments where booking_id = $1 and crew_role = 'lead'`, [bookingId])
  return { status: b.status as string, delivery: d?.status as string, lead: da?.driver_id as string }
}

const altInput = { driver_id: altDriverId, truck_id: altTruckId } as any
let failures = 0

try {
  console.log('\nR2  re-assigning a booking the driver has started')
  await claimDeliveryStart(bookingId, actor)
  let threw = ''
  try { await AssignmentModel.assign(bookingId, altInput, null) } catch (e) { threw = (e as Error).message }
  const r2 = await state()
  const r2ok = !!threw && r2.status === 'in_transit' && r2.lead === lead.driver_id
  if (!r2ok) failures++
  console.log(`  ${r2ok ? 'ok  ' : 'FAIL'} assign ${threw ? `refused: "${threw}"` : 'ACCEPTED'}; status=${r2.status} lead=${r2.lead === lead.driver_id ? 'original' : 'NEW'}`)
  await restore()

  console.log(`\nR1  start and re-assign at the same instant, ${rounds} rounds`)
  const tally: Record<string, number> = {}
  for (let i = 0; i < rounds; i++) {
    // A random head start for the office, so both orders get exercised: the
    // assign reads the vehicle model before it takes the lock.
    const jitter = Math.floor(Math.random() * 600)
    const [start, assign] = await Promise.allSettled([
      new Promise((r) => setTimeout(r, jitter)).then(() => claimDeliveryStart(bookingId, actor)),
      AssignmentModel.assign(bookingId, altInput, null),
    ])
    const s = await state()
    const startOk  = start.status === 'fulfilled'
    const assignOk = assign.status === 'fulfilled'
    // Exactly one wins, and the row says who.
    const consistent =
      (startOk && !assignOk && s.status === 'in_transit' && s.delivery === 'in_transit' && s.lead === lead.driver_id) ||
      (!startOk && assignOk && s.status === 'assigned' && s.lead === altDriverId)
    if (!consistent) failures++
    const why = (r: PromiseSettledResult<unknown>) => r.status === 'fulfilled' ? 'won' : `refused (${(r.reason as Error).message.slice(0, 50)})`
    const label = `start ${why(start)} / assign ${why(assign)} → status=${s.status} lead=${s.lead === lead.driver_id ? 'original' : 'new'}${consistent ? '' : '  MIXED'}`
    tally[label] = (tally[label] ?? 0) + 1
    await restore()
  }
  for (const [k, n] of Object.entries(tally)) console.log(`  ${String(n).padStart(3)}×  ${k}`)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} inconsistent outcome(s)`)
} finally {
  await restore()
  const after = await state()
  console.log(`restored: status=${after.status} delivery=${after.delivery} lead=${after.lead === lead.driver_id ? 'original' : 'WRONG'}`)
  await pool.end()
}
