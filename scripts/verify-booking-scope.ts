/**
 * Proves a caller cannot read another owner's bookings by changing the id in
 * the URL.
 *
 *   npx tsx scripts/verify-booking-scope.ts
 *
 * Both list routes take an owner id as a path parameter — `/booking/client/:id`
 * and `/booking/driver/:id` — which is only safe because the service pins the id
 * to the caller's session. This calls the services the way the controllers do
 * and checks the pinning holds. Read-only; nothing is written.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import {
  getBookingsByClientService,
  getBookingsByDriverService,
} from '../src/services/client/booking.service.js'

let passed = 0
const failures: string[] = []
const ok = (l: string) => { passed++; console.log(`  ok   ${l}`) }
const bad = (l: string, d = '') => {
  failures.push(`${l}${d ? ` — ${d}` : ''}`)
  console.log(`  FAIL ${l}${d ? ` — ${d}` : ''}`)
}
const check = (l: string, cond: boolean, d = '') => (cond ? ok(l) : bad(l, d))

const { rows: clients } = await pool.query(
  `select c.client_id,
          (select count(*) from bookings b where b.client_id = c.client_id) as n
     from clients c order by n desc limit 2`)
const { rows: drivers } = await pool.query(
  `select d.driver_id,
          (select count(*) from driver_assignments a where a.driver_id = d.driver_id) as n
     from drivers d order by n desc limit 2`)

console.log('\nClient list is pinned to the session')
if (clients.length >= 2) {
  const [mine, theirs] = clients
  // A client viewer aimed at ANOTHER client's id.
  const rows = await getBookingsByClientService(theirs.client_id, {
    role: 'client', clientId: mine.client_id,
  })
  check('asking for another client returns only my own',
    rows.every((b) => (b as { client_id: string }).client_id === mine.client_id),
    `${rows.filter((b) => (b as { client_id: string }).client_id !== mine.client_id).length} foreign row(s)`)

  const staff = await getBookingsByClientService(theirs.client_id, { role: 'admin', clientId: null })
  check('staff still read the client they asked for',
    staff.every((b) => (b as { client_id: string }).client_id === theirs.client_id))
} else {
  console.log('  (need 2 clients to compare — skipped)')
}

check('a client with no client row gets nothing',
  (await getBookingsByClientService(clients[0]?.client_id ?? 'x', { role: 'client', clientId: null })).length === 0)

console.log('\nDriver list is pinned to the session')
if (drivers.length >= 2) {
  const [mine, theirs] = drivers
  const mineRows = await getBookingsByDriverService(mine.driver_id, {
    role: 'driver', clientId: null, driverId: mine.driver_id,
  })
  const spoofed = await getBookingsByDriverService(theirs.driver_id, {
    role: 'driver', clientId: null, driverId: mine.driver_id,
  })
  check('asking for another driver returns my own list, not theirs',
    JSON.stringify(spoofed.map((b) => (b as { booking_id: string }).booking_id).sort()) ===
    JSON.stringify(mineRows.map((b) => (b as { booking_id: string }).booking_id).sort()))

  const staff = await getBookingsByDriverService(theirs.driver_id, { role: 'admin', clientId: null })
  check('staff still read the driver they asked for',
    JSON.stringify(staff.map((b) => (b as { booking_id: string }).booking_id).sort()) ===
    JSON.stringify(
      (await getBookingsByDriverService(theirs.driver_id, {
        role: 'driver', clientId: null, driverId: theirs.driver_id,
      })).map((b) => (b as { booking_id: string }).booking_id).sort()))
} else {
  console.log('  (need 2 drivers to compare — skipped)')
}

// An unresolved driver must scope to nothing rather than fall back to the URL.
check('a driver whose row could not be resolved gets nothing',
  (await getBookingsByDriverService(drivers[0]?.driver_id ?? 'x', {
    role: 'driver', clientId: null, driverId: null,
  })).length === 0,
  'falling back to the URL id here would reopen the hole')

await pool.end()

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.log(`  x ${f}`)
  process.exitCode = 1
} else {
  console.log(`PASSED — all ${passed} checks green`)
}
