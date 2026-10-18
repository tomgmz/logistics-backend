/**
 * Times recorded by a phone whose clock is wrong, corrected by the clock it
 * sends with each request (X-Device-Time). Runs the services inside a request
 * context exactly as the app's requests are, on a QA booking, then restores it.
 *
 *   SUPPRESS_NOTIFICATIONS=1 npx tsx scripts/verify-device-clock.ts <bookingId>
 *
 * The booking must be 'assigned' with a pending first trip and a lead driver.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import { requestContext } from '../src/lib/request-context.js'
import { claimDeliveryStart } from '../src/services/driver/start-delivery.service.js'
import { driverRecordMilestoneService } from '../src/services/client/milestone.service.js'
import { pauseTripService, driverResumeTripService } from '../src/services/client/pause.service.js'
import { stampFieldsFrom } from '../src/services/driver/proof-stamp.service.js'

if (process.env.SUPPRESS_NOTIFICATIONS !== '1') { console.error('Run with SUPPRESS_NOTIFICATIONS=1.'); process.exit(1) }
const [bookingId] = process.argv.slice(2)
if (!bookingId) { console.error('usage: … <bookingId>'); process.exit(1) }
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[]
const [{ t: startedAt }] = (await pool.query(`select (now() at time zone 'utc')::text t`)).rows

const H3   = 3 * 3600_000
const MIN  = 60_000
const iso  = (ms: number) => new Date(ms).toISOString()
/** Run `fn` as a request from a phone whose clock reads `phoneNow` as it sends. */
function asPhone<T>(phoneNow: number | null, fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req: any = { headers: phoneNow == null ? {} : { 'x-device-time': iso(phoneNow) }, originalUrl: '/qa', method: 'POST' }
    requestContext(req, {} as any, () => { fn().then(resolve, reject) })
  })
}

async function cols(table: string) {
  return (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1
                    and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS' order by ordinal_position`, [table]))
    .map((r) => `"${r.column_name}"`).join(', ')
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
const actor = { userId: lead.user_id as string, role: 'driver' }

async function restore() {
  await q(`delete from stop_milestones where booking_id = $1`, [bookingId])
  await q(`delete from booking_pauses where booking_id = $1 and created_at >= ($2::timestamp at time zone 'utc')`, [bookingId, startedAt])
  await updateBack('bookings', 'booking_id', snap.booking)
  await updateBack('deliveries', 'delivery_id', snap.delivery)
  await updateBack('booking_trips', 'trip_id', snap.trips)
  await new Promise((r) => setTimeout(r, 1500))   // let background audit writes land first
  await q(`delete from audit_logs where timestamp >= $1::timestamp and description ilike $2`, [startedAt, `%${b0.reference_number}%`])
}

let failures = 0
const near = (a: number, b: number, tol = 15_000) => Math.abs(a - b) <= tol
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const fmt = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 16) + ' PHT'

try {
  await claimDeliveryStart(bookingId, actor)
  const real = Date.now()
  console.log(`\nPhone clock 3 h ahead. Real time now ${fmt(real)}, phone shows ${fmt(real + H3)}.`)

  console.log('\nStop-time taps')
  // Tapped offline 30 min ago (phone read real-30m+3h), synced now.
  const a = await asPhone(Date.now() + H3, () => driverRecordMilestoneService(bookingId,
    { stage: 'arrived_parking', trip_id: trip.trip_id, at: iso(real - 30 * MIN + H3) }, actor))
  check('offline tap, synced 30 min later', near(Date.parse(a.at), real - 30 * MIN), `saved ${fmt(Date.parse(a.at))}, real tap ${fmt(real - 30 * MIN)}`)
  check('  not flagged', a.clock_adjusted === false)

  // Docked 20 min ago, also offline, synced now.
  const d = await asPhone(Date.now() + H3, () => driverRecordMilestoneService(bookingId,
    { stage: 'docked', trip_id: trip.trip_id, at: iso(real - 20 * MIN + H3) }, actor))
  check('offline tap, phone 3 h ahead the whole time', near(Date.parse(d.at), real - 20 * MIN), `saved ${fmt(Date.parse(d.at))}, real tap ${fmt(real - 20 * MIN)}`)

  // Tapped live (sent at once).
  const s = await asPhone(Date.now() + H3, () => driverRecordMilestoneService(bookingId,
    { stage: 'started', trip_id: trip.trip_id, at: iso(Date.now() + H3) }, actor))
  check('live tap', near(Date.parse(s.at), Date.now()), `saved ${fmt(Date.parse(s.at))}`)

  // An app without the header (old build): previous rule. Before the finish is
  // set below, which would (rightly) cap a re-tapped start at the finish time.
  await q(`delete from stop_milestones where booking_id = $1 and stage = 'started'`, [bookingId])
  const legacy = await asPhone(null, () => driverRecordMilestoneService(bookingId,
    { stage: 'started', trip_id: trip.trip_id, at: iso(Date.now() + H3) }, actor))
  check('no clock header: a live tap uses the server clock', near(Date.parse(legacy.at), Date.now()), `saved ${fmt(Date.parse(legacy.at))}`)

  // Clock changed between tap and send: tapped 5 min ago with a CORRECT clock,
  // then the driver moved the clock 3 h ahead before signal came back.
  await q(`update booking_trips set status = 'in_transit', pickup_proof_photo_url = 'https://example.invalid/qa.jpg', pickup_proof_at = now() - interval '2 minutes' where trip_id = $1`, [trip.trip_id])
  const dep = await asPhone(Date.now() + H3, () => driverRecordMilestoneService(bookingId,
    { stage: 'departed', trip_id: trip.trip_id, at: iso(real - 1 * MIN) }, actor))
  check('clock changed before syncing: kept in order (not before the finish)', Date.parse(dep.at) >= Date.now() - 2 * MIN - 5000, `saved ${fmt(Date.parse(dep.at))}`)
  check('  and flagged for the office', dep.clock_adjusted === true)

  console.log('\nPause and resume')
  const pausedPhone = real - 15 * MIN + H3
  await asPhone(Date.now() + H3, () => pauseTripService(bookingId,
    { reason: 'weather', note: 'QA clock test', paused_at: iso(pausedPhone) } as any, actor))
  const [p] = await q(`select paused_at from booking_pauses where booking_id = $1 and resumed_at is null`, [bookingId])
  check('pause queued 15 min ago', near(new Date(p.paused_at).getTime(), real - 15 * MIN), `saved ${fmt(new Date(p.paused_at).getTime())}`)
  await asPhone(Date.now() + H3, () => driverResumeTripService(bookingId, actor, iso(real - 5 * MIN + H3)))
  const [r] = await q(`select resumed_at from booking_pauses where booking_id = $1 order by paused_at desc limit 1`, [bookingId])
  check('resume queued 5 min ago', near(new Date(r.resumed_at).getTime(), real - 5 * MIN), `saved ${fmt(new Date(r.resumed_at).getTime())}`)

  console.log('\nPhoto stamp')
  const fields = await asPhone(Date.now() + H3, async () => stampFieldsFrom({
    stamp_stop: 'trip_pickup', stamp_ref: trip.trip_id, taken_at: iso(real - 10 * MIN + H3),
  }))
  check('photo taken 10 min ago, uploaded now', !!fields?.takenAt && near(fields.takenAt.getTime(), real - 10 * MIN),
    fields?.takenAt ? `stamped ${fmt(fields.takenAt.getTime())}` : 'no time')

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`)
} finally {
  await restore()
  const [b] = await q(`select status::text s, paused_at from bookings where booking_id = $1`, [bookingId])
  const [m] = await q(`select count(*)::int n from stop_milestones where booking_id = $1`, [bookingId])
  const [pp] = await q(`select count(*)::int n from booking_pauses where booking_id = $1`, [bookingId])
  console.log(`restored: status=${b.s} paused=${!!b.paused_at} milestones=${m.n} pauses=${pp.n}`)
  await pool.end()
}
