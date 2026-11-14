/**
 * Fills every module with test data covering every scenario the system has,
 * about 20 rows per module (user 2026-11-14). A module goes over 20 only where
 * its scenarios need it: every booking scenario is kept, and each live
 * delivery needs its own driver and vehicle.
 *
 *   npx tsx scripts/seed-scenarios.mjs --dry-run   # build everything, then roll back + remove auth users/files
 *   npx tsx scripts/seed-scenarios.mjs             # insert for real
 *   npx tsx scripts/teardown-scenarios.mjs [--yes] # remove exactly what this inserted
 *
 * Everything inserted is recorded in scripts/seed-scenarios.manifest.json
 * (git-ignored next to backups/): table -> ids, auth user ids, stored files.
 * The teardown deletes by those ids only, never by pattern.
 *
 * Accounts: every seeded person signs in with ONE shared password (printed at
 * the end, saved in the manifest). Emails are plus-addresses of the testing
 * inbox (8338logisticsservice+seed.<kind><nnn>@gmail.com), so whatever the
 * schedulers email them lands there instead of bouncing.
 *
 * LIVE ON PURPOSE (the user's choice, 2026-11-07): no reminder or notice stamp
 * is pre-set. The schedulers treat seeded rows like real ones: delays, the
 * breakdown reminder, overdue pauses, expiring licences / registrations /
 * contracts and the 3-day auto-complete all fire, to seeded AND real staff.
 *
 * Left out on purpose: sessions, push tokens, passkeys, OTP codes, record
 * locks (all need a real device or browser); an open IT Administrator
 * handover (the render scheduler would act on the real IT Administrator);
 * a ringing SOS call (it would ring real browsers); removed modules' tables
 * (maintenance_records/requests, chatbot_tickets, chat_calls, gps_tracking,
 * app_releases, vehicle_coding_schedules).
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { defaultPermissionsForRole, levelToFlags, MODULES_BY_ROLE } from '../src/constants/modules.ts'

const DRY = process.argv.includes('--dry-run')
const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-scenarios.manifest.json')
if (!DRY && fs.existsSync(MANIFEST)) {
  console.error(`${MANIFEST} already exists. Run the teardown first (or delete the file if it is stale).`)
  process.exit(1)
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
pool.on('error', (err) => console.error('pool client error:', err.message))
const s3 = new S3Client({
  region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
})
const BUCKET = process.env.R2_FILES_BUCKET

const PASSWORD = `Seed-${crypto.randomBytes(6).toString('base64url')}-8338!`
const manifest = { created_at: new Date().toISOString(), password: PASSWORD, auth_user_ids: [], files: [], tables: {} }
const saveManifest = () => { if (!DRY) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2)) }
const track = (table, id) => { (manifest.tables[table] ??= []).push(id) }

// ------------------------------------------------------------------ helpers
const pad  = (n, w = 3) => String(n).padStart(w, '0')
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length]
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
/** Philippine calendar day, `offset` days from today. */
const phDay = (offset = 0) => new Date(Date.now() + 8 * HOUR + offset * DAY).toISOString().slice(0, 10)
/** A Philippine wall-clock time on a Philippine day. */
const at   = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+08:00`)
const ago  = (minutes) => new Date(Date.now() - minutes * MIN)
const plus = (d, minutes) => new Date(d.getTime() + minutes * MIN)
const NOW  = new Date()

const FIRST = ['Juan', 'Maria', 'Jose', 'Ana', 'Mark', 'Grace', 'Paolo', 'Liza', 'Carlo', 'Joy', 'Rafael', 'Bea', 'Miguel', 'Kris', 'Andre', 'Nina', 'Ramon', 'Tess', 'Luis', 'Camille', 'Arnel', 'Divina', 'Noel', 'Rowena', 'Jerome']
const LAST  = ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Garcia', 'Mendoza', 'Torres', 'Flores', 'Villanueva', 'Ramos', 'Castillo', 'Aquino', 'Navarro', 'Domingo', 'Salazar', 'Rivera', 'Del Rosario', 'Pascual', 'Lim', 'Tan', 'Manalo', 'Dizon', 'Ocampo']
const COMPANY_A = ['Luzon', 'Pacific', 'Metro', 'Golden', 'Island', 'Northstar', 'Bayani', 'Sampaguita', 'Mabuhay', 'Coral', 'Silangan', 'Harbor']
const COMPANY_B = ['Consumer Goods', 'Distribution', 'Trading', 'Foods', 'Beverages', 'Retail Supply', 'Marketing', 'Household Products']
const PLACES = [
  { a: 'Km 14 East Service Road, Paranaque City', lat: 14.4950, lng: 121.0410 },
  { a: 'Alabang-Zapote Road, Muntinlupa City', lat: 14.4231, lng: 121.0300 },
  { a: 'Maharlika Village, Taguig City', lat: 14.5040, lng: 121.0520 },
  { a: 'EDSA corner Shaw Boulevard, Mandaluyong City', lat: 14.5814, lng: 121.0536 },
  { a: 'Commonwealth Avenue, Quezon City', lat: 14.6850, lng: 121.0800 },
  { a: 'MacArthur Highway, Valenzuela City', lat: 14.7000, lng: 120.9830 },
  { a: 'Ortigas Avenue Extension, Pasig City', lat: 14.5880, lng: 121.1010 },
  { a: 'Marcos Highway, Marikina City', lat: 14.6330, lng: 121.1050 },
  { a: 'Gil Puyat Avenue, Makati City', lat: 14.5540, lng: 121.0140 },
  { a: 'Roxas Boulevard, Pasay City', lat: 14.5370, lng: 120.9890 },
  { a: 'Aguinaldo Highway, Imus, Cavite', lat: 14.4290, lng: 120.9370 },
  { a: 'National Highway, Calamba, Laguna', lat: 14.2117, lng: 121.1653 },
  { a: 'Mac Arthur Highway, San Fernando, Pampanga', lat: 15.0286, lng: 120.6898 },
  { a: 'Governor\'s Drive, Dasmarinas, Cavite', lat: 14.3294, lng: 120.9367 },
]
/** Live deliveries only drive between these (all inland), so a truck on the map never sits in Manila Bay or Laguna de Bay. */
const INLAND = PLACES.slice(0, 9)
const COMMODITIES =['Beverages', 'Snacks', 'Personal Care', 'Household Cleaning', 'Canned Goods', 'Dairy']
const PRODUCTS    = ['Bottled Water 500ml', 'Potato Chips 60g', 'Shampoo Sachet', 'Dishwashing Liquid 250ml', 'Corned Beef 150g', 'Evaporated Milk 370ml']
const ALL_PASS    = { air: true, gas: true, oil: true, self: true, tires: true, water: true, brakes: true, engine: true, lights: true, battery: true }

/** Straight-line km between two points, times 1.3 for roads. */
function roadKm(a, b) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3
}
/** The cache key route-distance.service builds, so no Google call is needed for seeded bookings. */
const routeKey = (pts) => pts.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')

// ------------------------------------------------------------ stored files
async function placeholder(label, sub, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720">
    <rect width="100%" height="100%" fill="${color}"/>
    <rect x="40" y="40" width="880" height="640" fill="none" stroke="#ffffff" stroke-width="6" stroke-dasharray="24 16"/>
    <text x="480" y="330" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="#ffffff" text-anchor="middle">${label}</text>
    <text x="480" y="410" font-family="Arial, sans-serif" font-size="32" fill="#ffffff" text-anchor="middle">${sub}</text>
    <text x="480" y="640" font-family="Arial, sans-serif" font-size="24" fill="#ffffff" text-anchor="middle">8338 Logistics · seed test file</text>
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer()
}
async function upload(folder, label, sub, color) {
  const buf = await placeholder(label, sub, color)
  const key = `${folder}/seed-${crypto.randomUUID()}.jpg`
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: 'image/jpeg' }))
  manifest.files.push(key)
  return { ref: `r2://${key}`, bytes: buf.length }
}

console.log(DRY ? 'DRY RUN: everything is built, then rolled back and cleaned up.\n' : 'Seeding PRODUCTION.\n')
console.log('Uploading placeholder files…')
const FILES = {
  model:     await upload('truck_models', 'VEHICLE MODEL', 'placeholder picture', '#1f2937'),
  license:   await upload('driver_licenses', 'DRIVER LICENSE', 'placeholder card', '#0f766e'),
  pickup:    await upload('delivery_proofs/stamped', 'PICKUP PROOF', 'loaded at the warehouse', '#1d4ed8'),
  dropoff:   await upload('delivery_proofs/stamped', 'DROP-OFF PROOF', 'signed DR + goods', '#15803d'),
  dropoff2:  await upload('delivery_proofs/stamped', 'DROP-OFF PROOF', 'stacked at the bay', '#166534'),
  report:    await upload('driver_reports', 'INCIDENT PHOTO', 'flat tyre / damage', '#b91c1c'),
  odometer:  await upload('odometer', 'ODOMETER', 'dashboard reading', '#374151'),
  receipt:   await upload('service_receipts', 'SERVICE RECEIPT', 'workshop invoice', '#92400e'),
  document:  await upload('booking_documents/seed', 'DOCUMENT', 'scanned paperwork', '#4338ca'),
  contract:  await upload('client_contracts/seed', 'CONTRACT', 'signed service agreement', '#6b21a8'),
  transfer:  await upload('delivery_proofs/stamped', 'LOAD TRANSFER', 'cargo moved to new vehicle', '#c2410c'),
  chat:      await upload('chat_photos', 'CHAT PHOTO', 'bay door closed', '#0e7490'),
}
console.log(`  ${manifest.files.length} files`)

// ------------------------------------------------------------- auth users
const inboxFor = (tag) => `8338logisticsservice+seed.${tag}@gmail.com`
async function createAuthUser(email) {
  const { data, error } = await supabase.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { seed: 'scenarios' },
  })
  if (error) throw new Error(`auth user ${email}: ${error.message}`)
  manifest.auth_user_ids.push(data.user.id)
  return data.user.id
}
async function createGroup(kind, role, tag, n) {
  const out = []
  for (let start = 0; start < n; start += 10) {
    const batch = await Promise.all(Array.from({ length: Math.min(10, n - start) }, (_, k) => start + k).map(async (i) => {
      const email = inboxFor(`${tag}${pad(i + 1)}`)
      return { i, kind, role, email, id: await createAuthUser(email) }
    }))
    out.push(...batch)
    saveManifest()
  }
  console.log(`  ${kind.padEnd(26)} ${out.length}`)
  return out
}

async function removeAuthAndFiles() {
  let a = 0
  for (const id of manifest.auth_user_ids) { const { error } = await supabase.auth.admin.deleteUser(id); if (!error) a++ }
  let f = 0
  for (const key of manifest.files) { try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); f++ } catch { /* reported below */ } }
  console.log(`Cleaned up: ${a}/${manifest.auth_user_ids.length} auth users, ${f}/${manifest.files.length} files.`)
}

/**
 * One entry per scenario. phase:
 *   none     no crew yet (pending / approved / cancelled)
 *   planned  crewed, trips planned, not started
 *   loading  started, at the warehouse, no pickup proof yet
 *   enroute  loaded, heading to the first drop-off
 *   midway   first drop-off done, arrived at the next (needs 2+ stops)
 *   trip2    multi-trip: run 1 done, run 2 on the road
 *   done     every run finished
 */
const S = [
  // waiting for the General Manager
  { label: 'Pending, new',                            status: 'pending',   day: 3 },
  { label: 'Pending, 3 drop-offs, palletized',        status: 'pending',   day: 5, stops: 3 },
  { label: 'Pending, booked for tomorrow',            status: 'pending',   day: 1, stops: 2 },
  { label: 'Pending, Sunday delivery',                status: 'pending',   day: 'sunday' },
  { label: 'Pending, resubmitted after a rejection',  status: 'pending',   day: 6, resubmitted: true },
  { label: 'Pending, catalog items + handling codes', status: 'pending',   day: 4, catalog: true },
  // decided by 8338
  { label: 'Rejected by the General Manager',         status: 'cancelled', day: 4, gm: 'rejected' },
  { label: 'Rejected by the Company Administrator',   status: 'cancelled', day: 4, gm: 'rejected', byAdmin: true },
  { label: 'Rejected, client closed it',              status: 'cancelled', day: -2, gm: 'rejected', clientClosed: true },
  { label: 'Rejected 3 times, cannot be resubmitted', status: 'cancelled', day: 5, gm: 'rejected', resubmitted: 3 },
  { label: 'Cancelled by the client before approval', status: 'cancelled', day: 7, clientCancel: true },
  { label: 'Cancelled by the client after approval',  status: 'cancelled', day: 8, gm: 'approved', clientCancel: true },
  { label: 'Approved, waiting for a vehicle',         status: 'approved',  day: 2, gm: 'approved', remarks: true },
  { label: 'Approved by the Company Administrator',   status: 'approved',  day: 3, gm: 'approved', byAdmin: true, stops: 2 },
  { label: 'Approved, for tomorrow (urgent to assign)', status: 'approved', day: 1, gm: 'approved' },
  // crewed, not started
  { label: 'Assigned',                                status: 'assigned',  day: 1, phase: 'planned', callTime: true },
  { label: 'Assigned for today',                      status: 'assigned',  day: 0, phase: 'planned', callTime: true },
  { label: 'Assigned, long route with a second driver', status: 'assigned', day: 2, phase: 'planned', second: true, far: true, stops: 2 },
  { label: 'Assigned, with a helper',                 status: 'assigned',  day: 2, phase: 'planned', helper: true },
  { label: 'Assigned, vendor-supplied vehicle',       status: 'assigned',  day: 3, phase: 'planned', vendor: true },
  { label: 'Assigned, two trips',                     status: 'assigned',  day: 4, phase: 'planned', trips: 2, stops: 2 },
  { label: 'Assigned, licence expires on the delivery day', status: 'assigned', day: 3, phase: 'planned', driverIdx: 9 },
  { label: 'Assigned, licence expires 2 days after',  status: 'assigned',  day: 3, phase: 'planned', driverIdx: 10 },
  // on the road
  { label: 'In transit, at the warehouse loading',    status: 'in_transit', day: 0, phase: 'loading' },
  { label: 'In transit, loaded, en route',            status: 'in_transit', day: 0, phase: 'enroute', stops: 2 },
  { label: 'In transit, 1 of 3 delivered',            status: 'in_transit', day: 0, phase: 'midway', stops: 3 },
  { label: 'In transit, delayed 40 min',              status: 'in_transit', day: 0, phase: 'enroute', delayed: 40, stops: 2 },
  { label: 'In transit, late with no signal',         status: 'in_transit', day: 0, phase: 'enroute', delayed: 75, noSignal: true },
  { label: 'In transit, paused (typhoon), continues tomorrow', status: 'in_transit', day: 0, phase: 'enroute', pause: 'weather_set' },
  { label: 'In transit, paused, date to be confirmed', status: 'in_transit', day: -1, phase: 'enroute', pause: 'closed_tbc', stops: 2 },
  { label: 'In transit, paused, continuation overdue', status: 'in_transit', day: -1, phase: 'midway', pause: 'overdue', stops: 2 },
  { label: 'In transit, breakdown, needs a decision', status: 'in_transit', day: 0, phase: 'enroute', breakdown: 'pending' },
  { label: 'In transit, paused for breakdown',        status: 'in_transit', day: 0, phase: 'enroute', breakdown: 'paused' },
  { label: 'In transit, crew replaced, load transfer pending', status: 'in_transit', day: 0, phase: 'enroute', crewReplaced: true },
  { label: 'In transit, second driver at the wheel',  status: 'in_transit', day: 0, phase: 'midway', second: true, far: true, wheel: 'switch', stops: 2 },
  { label: 'In transit, office swapped main and second driver', status: 'in_transit', day: 0, phase: 'enroute', second: true, far: true, wheel: 'staff' },
  { label: 'In transit, drop-off confirmed by the office', status: 'in_transit', day: 0, phase: 'midway', officeConfirm: true, stops: 2 },
  { label: 'In transit, run 1 done, run 2 on the road', status: 'in_transit', day: 0, phase: 'trip2', trips: 2, stops: 2 },
  { label: 'In transit, vendor-supplied vehicle',     status: 'in_transit', day: 0, phase: 'enroute', vendor: true },
  { label: 'In transit, late drop-off confirmation waiting', status: 'in_transit', day: 0, phase: 'enroute', second: true, wheel: 'staff', lateConfirm: true, stops: 2 },
  // delivered, waiting on the client
  { label: 'Delivered, waiting for the client',       status: 'delivered', day: 0, phase: 'done', returned: false },
  { label: 'Delivered, reminder sent',                status: 'delivered', day: -2, phase: 'done', reminder: true },
  { label: 'Delivered, client reported a problem',    status: 'delivered', day: -1, phase: 'done', issue: 'open' },
  { label: 'Delivered, problem resolved by 8338',     status: 'delivered', day: -2, phase: 'done', issue: 'resolved' },
  { label: 'Delivered, goods stolen (incident)',      status: 'delivered', day: -1, phase: 'done', failed: 'all', stops: 2 },
  { label: 'Delivered, client refused one drop-off',  status: 'delivered', day: -1, phase: 'done', failed: 'one', stops: 2 },
  { label: 'Delivered, office confirmed every step',  status: 'delivered', day: 0, phase: 'done', officeConfirm: true },
  { label: 'Delivered, vehicle not back yet',         status: 'delivered', day: 0, phase: 'done', returned: false, stops: 2 },
  // finished
  { label: 'Completed, confirmed by the client',      status: 'completed', day: -4, phase: 'done' },
  { label: 'Completed automatically after 3 days',    status: 'completed', day: -6, phase: 'done', auto: true },
  { label: 'Completed, ran 55 min late',              status: 'completed', day: -5, phase: 'done', wasDelayed: 55, stops: 2 },
  { label: 'Completed, two trips',                    status: 'completed', day: -7, phase: 'done', trips: 2, stops: 3 },
  { label: 'Completed, vendor-supplied vehicle',      status: 'completed', day: -8, phase: 'done', vendor: true },
  { label: 'Completed, second driver',                status: 'completed', day: -9, phase: 'done', second: true, far: true },
  { label: 'Completed, was paused and resumed',       status: 'completed', day: -10, phase: 'done', pastPause: true },
  { label: 'Completed last month (older app: no finished step)', status: 'completed', day: -35, phase: 'done', stops: 3, oldApp: true },
]
/** A crewed company booking that holds its driver + vehicle (the rest reuse the live pool). */
const holdsCrew = (sc) => !!sc.phase && !sc.vendor && (['in_transit', 'assigned'].includes(sc.status) || (sc.status === 'delivered' && sc.returned === false))
// Company drivers + vehicles: 0–16 carry the driver / Vehicle Management scenarios,
// then one per live delivery (+1 for the crew replacement), then the second drivers,
// then (drivers only) the account states.
const LIVE_START  = 17
const LIVE_COUNT  = S.filter(holdsCrew).length + S.filter((sc) => sc.crewReplaced).length
const SECOND_START = LIVE_START + LIVE_COUNT
const SECOND_COUNT = S.filter((sc) => holdsCrew(sc) && sc.second).length
const N_TRUCKS  = SECOND_START
const N_DRIVERS = SECOND_START + SECOND_COUNT + 6

let people
try {
  console.log('Creating sign-in accounts…')
  people = {
    client: await createGroup('clients', 'client', 'client', 20),
    driver: await createGroup('company drivers', 'driver', 'driver', N_DRIVERS),
    vendor: await createGroup('vendor drivers', 'driver', 'vendor', 10),
    admin:  await createGroup('Company Administrators', 'admin', 'admin', 7),
    gm:     await createGroup('General Managers (archived)', 'general_manager', 'gm', 3),
    ops:    await createGroup('Operations Managers', 'operations_manager', 'ops', 8),
    fleet:  await createGroup('Fleet Managers', 'fleet_manager', 'fleet', 6),
  }
} catch (err) {
  console.error('Creating accounts failed:', err.message)
  await removeAuthAndFiles()
  process.exit(1)
}

// ------------------------------------------------------------------ database
const db = await pool.connect()
const summary = []
try {
  await db.query('BEGIN')

  /** Insert one row; Dates become ISO strings (UTC), plain objects become JSON. */
  const ins = async (table, pk, row) => {
    const cols = Object.keys(row)
    const vals = Object.values(row).map((v) =>
      v instanceof Date ? v.toISOString()
      : v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v)
      : v)
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, k) => `$${k + 1}`).join(', ')}) RETURNING ${pk}`
    const id = (await db.query(sql, vals)).rows[0][pk]
    track(table, id)
    return id
  }
  const upd = (table, pk, id, row) => {
    const cols = Object.keys(row)
    const vals = Object.values(row).map((v) => (v instanceof Date ? v.toISOString() : v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v))
    return db.query(`UPDATE ${table} SET ${cols.map((c, k) => `${c} = $${k + 2}`).join(', ')} WHERE ${pk} = $1`, [id, ...vals])
  }

  // ---------------------------------------------------------------- users
  const takenPhones = new Set((await db.query(`select phone from users where phone is not null`)).rows.map((r) => r.phone))
  let phoneSeq = 1000000
  const nextPhone = () => { let p; do { p = `0998${phoneSeq++}` } while (takenPhones.has(p)); return p }

  /**
   * Account states, so User Management shows each one. The last indexes of
   * every kind carry them; everything else is active.
   */
  const ACCOUNT_STATES = {
    deactivated:        { status: 'deactivated' },
    permanently_locked: { status: 'permanently_locked', failed_login_attempts: 5, lockup_count: 3 },
    archived:           { status: 'archived' },
    locked:             { status: 'active', failed_login_attempts: 5, lockup_count: 1, locked_until: plus(NOW, 25) },
    temp_password:      { status: 'active', must_change_password: true },
    never_signed_in:    { status: 'active', last_login_at: null },
  }
  // Clients and company drivers show every state; staff share them out, 2 per role.
  const STATES_BY_KIND = {
    client: Object.keys(ACCOUNT_STATES), driver: Object.keys(ACCOUNT_STATES),
    admin: ['deactivated', 'locked'], ops: ['archived', 'temp_password'], fleet: ['permanently_locked', 'never_signed_in'],
  }
  const stateFor = (p, n, kind) => {
    const names = STATES_BY_KIND[kind] ?? []
    const fromEnd = n - 1 - p.i
    return fromEnd < names.length ? names[fromEnd] : null
  }
  const sizes = Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.length]))
  let nameSeq = 0
  for (const [kind, list] of Object.entries(people)) {
    for (const p of list) {
      const k = nameSeq++
      // Only one General Manager may be un-archived, and that is the real one.
      const state = kind === 'gm' ? 'archived' : kind === 'vendor' ? null : stateFor(p, sizes[kind], kind)
      const extra = state ? ACCOUNT_STATES[state] : { status: 'active' }
      p.state = state ?? 'active'
      p.first = pick(FIRST, k)
      p.last  = pick(LAST, k * 7 + 3)
      await ins('users', 'user_id', {
        user_id: p.id, email: p.email, phone: nextPhone(), role: p.role,
        first_name: p.first, last_name: p.last, middle_name: k % 4 === 0 ? pick(LAST, k + 11) : null,
        suffix: k % 29 === 0 ? 'Jr.' : null,
        created_at: ago(60 * 24 * (120 - (k % 110))),
        last_login_at: 'last_login_at' in extra ? null : ago(30 + (k % 400) * 13),
        status: 'active', ...extra,
      })
    }
  }
  // An expired temporary password: the trigger stamps 7 days on insert; age it.
  for (const list of [people.client, people.driver, people.admin, people.ops, people.fleet]) {
    const p = list.find((x) => x.state === 'temp_password')
    if (p) await db.query(`update users set temp_password_expires_at = now() - interval '1 day' where user_id = $1`, [p.id])
  }
  const active = (list) => list.filter((p) => p.state === 'active')
  const admins = active(people.admin), opss = active(people.ops), fleets = active(people.fleet), gms = people.gm
  const ME = admins[0]  // the seeded Company Administrator who "does" most staff actions
  const nameOf = (p) => `${p.first} ${p.last}`

  // module permissions: role defaults; the second active account of each staff role is Read Only everywhere
  for (const [kind, list] of [['admin', people.admin], ['ops', people.ops], ['fleet', people.fleet], ['gm', people.gm]]) {
    for (const [j, p] of list.entries()) {
      const items = j === 1 && kind !== 'gm'
        ? MODULES_BY_ROLE[p.role].map((m) => ({ module_name: m, ...levelToFlags('read') }))
        : defaultPermissionsForRole(p.role)
      for (const it of items) {
        await ins('module_permissions', 'permission_id', {
          user_id: p.id, module_name: it.module_name, can_view: !!it.can_view, can_create: !!it.can_create,
          can_edit: !!it.can_edit, can_delete: !!it.can_delete, can_export: !!it.can_export, assigned_by: null,
        })
      }
    }
  }
  summary.push(['staff Read Only accounts', `${people.admin[1].email}, ${people.ops[1].email}, ${people.fleet[1].email}`])

  // ---------------------------------------------------------------- clients
  /** Contract scenarios on the first nine clients; the rest run 4–12 months out. */
  const CONTRACT = [null, 400, 30, 14, 7, 1, 0, -3, -12]
  const clients = []
  for (const p of people.client) {
    const offset = p.i < CONTRACT.length ? CONTRACT[p.i] : 120 + (p.i * 37) % 240
    const name = `${pick(COMPANY_A, p.i)} ${pick(COMPANY_B, p.i * 5 + 1)} ${pad(p.i + 1)}`
    const id = await ins('clients', 'client_id', {
      user_id: p.id, company_name: name, registered_name: `${name} Inc.`,
      billing_address: pick(PLACES, p.i).a, landline: `(02) 8${pad((p.i * 13) % 1000)}-${pad((p.i * 77) % 10000, 4)}`,
      contract_valid_until: offset === null ? null : phDay(offset),
    })
    clients.push({ ...p, client_id: id, company: name })
  }
  const bookingClients = clients.filter((c) => c.i >= 9 && c.state === 'active')

  // ------------------------------------------------------------ catalogs
  const existingNames = new Set((await db.query(
    `select lower(trim(name)) n from commodities union select lower(trim(name)) from products union select lower(trim(name)) from handling_codes union select lower(trim(code)) from handling_codes`,
  )).rows.map((r) => r.n))
  const commodityIds = []
  for (const [k, name] of COMMODITIES.entries()) {
    if (existingNames.has(name.toLowerCase())) continue
    commodityIds.push(await ins('commodities', 'commodity_id', { name, is_active: k !== 5 }))
  }
  const productIds = []
  for (const [k, name] of PRODUCTS.entries()) {
    if (existingNames.has(name.toLowerCase())) continue
    productIds.push(await ins('products', 'product_id', { name, commodity_id: commodityIds[k] ?? null, is_active: k !== 4 }))
  }
  const codeIds = []
  for (const [k, [code, name]] of [['PER', 'Perishable'], ['KEEPDRY', 'Keep Dry'], ['TOP', 'This Side Up'], ['COLD', 'Keep Cold']].entries()) {
    if (existingNames.has(code.toLowerCase()) || existingNames.has(name.toLowerCase())) continue
    codeIds.push(await ins('handling_codes', 'handling_code_id', { code, name, is_active: k !== 3 }))
  }
  const takenPrefixes = new Set((await db.query(`select prefix from landline_prefixes`)).rows.map((r) => r.prefix))
  for (const [k, [prefix, city]] of [['032', 'Cebu City'], ['045', 'Pampanga'], ['049', 'Laguna'], ['088', 'Cagayan de Oro']].entries()) {
    if (takenPrefixes.has(prefix)) continue
    await ins('landline_prefixes', 'prefix_id', { prefix, city, is_active: k !== 3 })
  }

  // ---------------------------------------------------------------- drivers
  /**
   * Company drivers. 0–10 carry the licence / status scenarios; LIVE_START.. crew
   * the live bookings; SECOND_START.. are second drivers; the last 6 are the account states.
   */
  const LICENSE = { 0: -10, 1: 0, 2: 1, 3: 7, 4: 30, 9: 3, 10: 5 }
  const STATUS  = { 6: 'on_leave', 7: 'inactive', 8: 'unavailable' }
  const drivers = []
  for (const p of people.driver) {
    const expiry = phDay(p.i in LICENSE ? LICENSE[p.i] : 300 + p.i * 9)
    const id = await ins('drivers', 'driver_id', {
      user_id: p.id, license_number: `S${10 + (p.i % 89)}-26-${pad(p.i + 1, 6)}`, license_expiry: expiry,
      license_image_url: FILES.license.ref, status: STATUS[p.i] ?? 'available', is_external: false,
      dl_codes: p.i % 3 === 0 ? ['A', 'B', 'C'] : ['B', 'C'], restriction_codes: ['1', '2'],
      license_verified_at: ago(60 * 24 * 30), license_verified_by: ME.id,
      emergency_contact_name: `${pick(FIRST, p.i + 5)} ${pick(LAST, p.i)}`, emergency_contact_phone: `0917${pad(p.i, 7)}`,
    })
    drivers.push({ ...p, driver_id: id, expiry })
  }
  // A renewal on record (history) for driver 5, and a renewal with a different number (with a note) for driver 11.
  for (const [i, note] of [[5, null], [11, 'Old card was lost; LTO issued a new number. Checked on LTMS.']]) {
    await ins('driver_license_history', 'history_id', {
      driver_id: drivers[i].driver_id, license_number: note ? `S99-21-${pad(i, 6)}` : drivers[i].license_number,
      license_expiry: phDay(-20), license_image_url: FILES.license.ref, dl_codes: ['B'], restriction_codes: ['1'],
      verified_at: ago(60 * 24 * 400), verified_by: ME.id, replaced_at: ago(60 * 24 * 21), replaced_by: ME.id,
      change_note: note, scanned: { license_number: drivers[i].license_number, expiry: drivers[i].expiry },
    })
  }
  // Opt-in availability: most company drivers ticked the next two weeks.
  for (const d of drivers) {
    if (d.i % 5 === 4 || STATUS[d.i]) continue
    for (let k = 0; k < 14; k++) {
      if ((d.i + k) % 6 === 0) continue
      await ins('driver_availability_days', 'availability_id', { driver_id: d.driver_id, available_on: phDay(k) })
    }
  }

  // Vendor drivers: password / emailed code like company drivers; a passkey is optional.
  const vendors = []
  for (const p of people.vendor) {
    const id = await ins('drivers', 'driver_id', {
      user_id: p.id, license_number: `V${10 + p.i}-25-${pad(p.i + 1, 6)}`,
      license_expiry: p.i % 4 === 3 ? null : phDay(200 + p.i * 11), status: 'available', is_external: true,
      vendor_name: `${pick(['JRS', 'Bulacan', 'Southline', 'RedRoute'], p.i)} Trucking Services`, vendor_contact: `0918${pad(p.i, 7)}`,
      emergency_contact_name: `${pick(FIRST, p.i + 9)} ${pick(LAST, p.i + 2)}`, emergency_contact_phone: `0919${pad(p.i, 7)}`,
    })
    vendors.push({ ...p, driver_id: id })
    const inviteState = pick(['consumed', 'sent', 'expired', 'revoked', 'consumed'], p.i)
    await ins('driver_enrollment_invites', 'invite_id', {
      user_id: p.id, email: p.email, token_hash: crypto.randomBytes(32).toString('hex'),
      expires_at: inviteState === 'expired' ? ago(60 * 24) : plus(NOW, 60 * 24 * 2), status: inviteState,
      consumed_at: inviteState === 'consumed' ? ago(60 * 24 * 5) : null, attempts: inviteState === 'consumed' ? 1 : 0,
      sent_by: pick(opss, p.i).id, created_at: ago(60 * 24 * 6),
    })
  }

  // ------------------------------------------------------- vehicle models + vehicles
  const types = (await db.query(`select name from vehicle_types where is_active order by name`)).rows.map((r) => r.name)
  const models = []
  for (let i = 0; i < 20; i++) {
    const wheels = pick([4, 6, 6, 10, 12], i)
    const type = pick(types, i)
    const name = `${pick(['Isuzu', 'Fuso', 'Hino', 'Foton', 'Hyundai'], i)} ${wheels}-Wheeler ${type} ${pad(i + 1)}`
    const id = await ins('truck_models', 'model_id', {
      name, vehicle_type: type, suitable_for: 'FMCG', stackable_friendly: i % 2 === 0,
      max_weight_kg: wheels * 1200, max_volume_cbm: wheels * 5, max_length_cm: 400 + wheels * 60,
      length_mm: 4000 + wheels * 600, width_mm: 2100, height_mm: 2200, image_url: FILES.model.ref,
      archived_at: i >= 18 ? ago(60 * 24 * 10) : null,
    })
    models.push({ id, name, type })
  }
  const liveModels = models.slice(0, 18)

  /**
   * Vehicle i belongs to company driver i. 0–16 carry the Vehicle Management
   * scenarios; LIVE_START.. crew the live bookings.
   */
  const TRUCK = {
    0:  { status: 'available', inspection: 'none' },                         // never inspected
    1:  { status: 'under_maintenance', inspection: 'fail' },                 // failed BLOWBAGETS
    2:  { status: 'under_maintenance', inspection: 'pass', report: 'reported' }, // driver reported a problem
    3:  { status: 'available', inspection: 'pass', service: 'overdue' },     // service overdue (blocks assignment)
    4:  { status: 'available', inspection: 'pass', service: 'due_soon' },
    5:  { status: 'available', inspection: 'pass', service: 'none' },        // no service schedule
    6:  { status: 'available', inspection: 'pass', registration: 30 },
    7:  { status: 'available', inspection: 'pass', registration: 7 },
    8:  { status: 'available', inspection: 'pass', registration: -5 },       // registration expired
    9:  { status: 'inactive', inspection: 'pass' },
    10: { status: 'archived', inspection: 'pass', noDriver: true },
    11: { status: 'archived', inspection: 'none', noDriver: true },
    12: { status: 'recheck_due', inspection: 'pass' },                       // back from a job, post-trip check due
    13: { status: 'available', inspection: 'pass', report: 'acknowledged' },
    14: { status: 'available', inspection: 'pass', report: 'resolved' },
    15: { status: 'under_maintenance', inspection: 'pass', service: 'overdue' },
    16: { status: 'available', inspection: 'pass', odometerDue: true },
  }
  const trucks = []
  for (let i = 0; i < N_TRUCKS; i++) {
    const t = TRUCK[i] ?? { status: 'available', inspection: 'pass' }
    const service = t.service ?? 'ok'
    const lastService = service === 'overdue' ? phDay(-240) : service === 'due_soon' ? phDay(-175) : service === 'none' ? null : phDay(-30 - (i % 40))
    const odo = 42000 + i * 173
    const model = pick(liveModels, i)
    const truckId = await ins('trucks', 'truck_id', {
      plate_number: `${pick(['NBC', 'NDA', 'NFE', 'NGH', 'NAJ'], i)} ${1000 + i * 7 + (i % 10)}`,
      status: t.status, model_id: model.id,
      registration_expiry: phDay(t.registration ?? 200 + i * 5),
      assigned_driver_id: t.noDriver ? null : drivers[i].driver_id,
      service_interval_km: service === 'none' ? null : 10000, service_interval_months: service === 'none' ? null : 6,
      last_service_at: lastService, last_service_odometer_km: lastService ? odo - (service === 'overdue' ? 12000 : 3000) : null,
      odometer_km: odo, odometer_recorded_at: ago(60 * (5 + i)),
    })
    trucks.push({ i, id: truckId, status: t.status, model, odo, plate: null })
    let inspId = null
    if (t.inspection !== 'none') {
      const passed = t.inspection === 'pass'
      inspId = await ins('truck_inspections', 'inspection_id', {
        truck_id: truckId, items: passed ? ALL_PASS : { ...ALL_PASS, brakes: false, tires: false },
        passed, notes: passed ? null : 'Brake pads worn out; rear tyres below tread limit',
        inspected_by: pick(fleets, i).id, inspected_at: ago(60 * 24 * (i === 12 ? 4 : 1) + i),
      })
    }
    await ins('truck_odometer_readings', 'reading_id', {
      truck_id: truckId, reading_km: odo, kind: i % 4 === 0 ? 'initial' : 'manual', photo_url: FILES.odometer.ref,
      inspection_id: inspId, recorded_by: pick(fleets, i).id, recorded_at: ago(60 * (5 + i)),
    })
    if (lastService) {
      await ins('truck_services', 'service_id', {
        truck_id: truckId, serviced_at: lastService, odometer_km: odo - (service === 'overdue' ? 12000 : 3000),
        work_done: pick(['Change oil and filter', 'Brake pad replacement', 'Tyre rotation', 'Preventive maintenance service'], i),
        workshop: `${pick(['Petron', 'Shell', 'Rapide', 'Goodyear'], i)} Service Center`, receipt_url: i % 3 === 0 ? FILES.receipt.ref : null,
        recorded_by: pick(fleets, i).id,
      })
    }
    if (t.report) {
      const place = pick(PLACES, i)
      await ins('driver_reports', 'report_id', {
        driver_id: drivers[i].driver_id, truck_id: truckId, source: 'detailed', incident_type: 'vehicle_breakdown',
        description: pick(['Engine overheats after 30 minutes on the expressway', 'Clutch slipping when loaded', 'Aircon and fan belt noise'], i),
        photo_urls: [FILES.report.ref], latitude: place.lat, longitude: place.lng, address: place.a, trip_can_continue: true,
        status: t.report,
        acknowledged_by: t.report !== 'reported' ? pick(fleets, i).id : null, acknowledged_at: t.report !== 'reported' ? ago(60 * 20) : null,
        resolved_by: t.report === 'resolved' ? pick(fleets, i).id : null, resolved_at: t.report === 'resolved' ? ago(60 * 2) : null,
        resolution_note: t.report === 'resolved' ? 'Fan belt replaced at the yard' : null, created_at: ago(60 * 26),
      })
    }
  }
  const plates = (await db.query(`select truck_id, plate_number from trucks where truck_id = any($1)`, [trucks.map((t) => t.id)])).rows
  for (const r of plates) trucks.find((t) => t.id === r.truck_id).plate = r.plate_number

  // ---------------------------------------------------------------- bookings

  const counterBefore = (await db.query(`select period, last_value from booking_reference_counters`)).rows
  const nextSunday = (() => { for (let k = 1; k <= 7; k++) { if (new Date(`${phDay(k)}T00:00:00Z`).getUTCDay() === 0) return k } })()

  // Crew pools: live bookings take driver+vehicle LIVE_START, … and second drivers SECOND_START, …
  let livePtr = LIVE_START, secondPtr = SECOND_START, histPtr = 0, vendorPtr = 0
  const liveDrivers = new Set(), liveTrucks = new Set()
  const scenarioRows = []
  const reportIds = []

  for (const [n, sc] of S.entries()) {
    const client = sc.clientIdx != null ? clients[sc.clientIdx] : pick(bookingClients, n * 7)
    const dayOffset = sc.day === 'sunday' ? nextSunday : sc.day
    const sched = phDay(dayOffset)
    const nStops = sc.stops ?? (n % 2) + 1
    // On-road deliveries stay inland (the map draws straight lines between fixes);
    // the long route comes down from Pampanga through Valenzuela first.
    const onMap = sc.status === 'in_transit'
    const origin = sc.far ? PLACES[12] : pick(onMap ? INLAND : PLACES, n)
    const stops = Array.from({ length: nStops }, (_, s) =>
      sc.far && s === 0 ? PLACES[5] : pick(onMap || sc.far ? INLAND.filter((p) => p !== origin && p !== PLACES[5]) : PLACES.slice(0, 11), n * 3 + s + 2))
    const route = [origin, ...stops]
    const km = route.slice(1).reduce((sum, p, k) => sum + roadKm(route[k], p), 0)
    const callTime = pick(['06:00', '07:30', '08:00', '09:15', '13:00'], n)
    const live = ['in_transit'].includes(sc.status) || sc.status === 'assigned' || (sc.status === 'delivered' && sc.returned === false)
    const crewed = !!sc.phase
    const createdAt = sc.day === 'sunday' ? ago(60 * 3) : new Date(Math.min(at(sched, '08:00').getTime() - 3 * DAY, ago(60 * (n + 1)).getTime()))
    const gm = sc.gm ?? (crewed ? 'approved' : 'pending')
    const reviewer = sc.byAdmin ? pick(admins, n) : pick(gms, n)
    const reviewedAt = plus(createdAt, 90)
    const ops = pick(opss, n)
    const assignedAt = plus(createdAt, 240)

    // crew
    let mainD = null, mainT = null, secondD = null, vendor = null
    if (crewed) {
      if (sc.vendor) {
        vendor = vendors[vendorPtr++ % vendors.length]
      } else if (live) {
        const idx = livePtr++
        mainT = trucks[idx]
        mainD = sc.driverIdx != null ? drivers[sc.driverIdx] : drivers[idx]
        liveDrivers.add(mainD.driver_id); liveTrucks.add(mainT.id)
        if (sc.second) { secondD = drivers[secondPtr++]; liveDrivers.add(secondD.driver_id) }
      } else {
        const idx = LIVE_START + (histPtr++ % LIVE_COUNT)
        mainD = drivers[idx]; mainT = trucks[idx]
        if (sc.second) secondD = drivers[SECOND_START + (histPtr % SECOND_COUNT)]
      }
      // The office swapped the seats: the old second driver is now the main driver.
      if (sc.wheel === 'staff') [mainD, secondD] = [secondD, mainD]
    }

    const delivered = ['delivered', 'completed'].includes(sc.status)
    // Timeline of a finished booking; a same-day one ran this morning (all in the past).
    const doneBase = sc.day === 0 ? ago(360) : at(sched, '08:00')
    const deliveredAt = delivered ? plus(doneBase, 60 * (2 + nStops)) : null
    // A delivery on the road since yesterday runs a day earlier.
    const shift = sc.day < 0 ? 60 * 24 : 0
    const agoR = (m) => ago(m + shift)

    const b = {
      client_id: client.client_id, origin: origin.a, origin_latitude: origin.lat, origin_longitude: origin.lng,
      schedule_date: sched, call_time: callTime, status: sc.status, created_at: createdAt,
      gm_status: gm, ops_status: crewed ? 'assigned' : 'pending',
      required_weight_kg: 0, required_volume_cbm: 0, required_length_cm: 120, stackable_required: n % 3 === 0,
      non_stackable_cargo: n % 5 === 0, route_distance_m: Math.round(km * 1000), route_distance_key: routeKey(route),
      truck_type_needed: crewed ? (vendor ? 'Closed Van' : mainT.model.name) : null,
      gm_reviewed_by: gm !== 'pending' ? reviewer.id : null, gm_reviewed_at: gm !== 'pending' ? reviewedAt : null,
      gm_reviewed_role: gm !== 'pending' ? (sc.byAdmin ? 'admin' : 'general_manager') : null,
      approval_remarks: sc.remarks ? 'Approved. Client asked for an early call time; coordinate with the warehouse.' : null,
      ops_assigned_by: crewed ? ops.id : null, ops_assigned_at: crewed ? assignedAt : null, ops_assigned_role: crewed ? 'operations_manager' : null,
      driver_call_time: crewed && sc.callTime ? pick(['05:30', '06:00', '06:30'], n) : null,
      rejection_reason: gm === 'rejected' ? pick(['Route not serviceable on the requested date', 'Cargo exceeds what the client declared; please split the booking', 'Drop-off address is incomplete'], n) : null,
      cancelled_by: sc.status === 'cancelled' ? (gm === 'rejected' ? reviewer.id : client.id) : null,
      cancelled_at: sc.status === 'cancelled' ? plus(createdAt, 180) : null,
      client_closed_at: sc.clientClosed ? plus(createdAt, 60 * 26) : null,
      resubmission_count: sc.resubmitted === true ? 1 : sc.resubmitted || 0,
      delivered_at: deliveredAt,
      completion_confirmed_by: sc.status === 'completed' && !sc.auto ? client.id : null,
      completion_confirmed_role: sc.status === 'completed' && !sc.auto ? 'client' : null,
      completion_confirmed_at: sc.status === 'completed' ? plus(deliveredAt, sc.auto ? 60 * 72 : 60 * 5) : null,
      completion_auto: !!sc.auto,
      completion_reminder_sent_at: sc.reminder ? ago(60) : sc.status === 'completed' && sc.auto ? plus(deliveredAt, 60 * 48) : null,
      client_issue_note: sc.issue ? 'Two cases of evaporated milk arrived dented; the receiver noted it on the DR.' : null,
      client_issue_reported_at: sc.issue ? plus(deliveredAt, 120) : null,
      client_issue_reported_by: sc.issue ? client.id : null,
      client_issue_resolved_at: sc.issue === 'resolved' ? plus(deliveredAt, 60 * 20) : null,
      client_issue_resolved_by: sc.issue === 'resolved' ? ME.id : null,
      client_issue_resolution_note: sc.issue === 'resolved' ? 'Replacement cases delivered on the next trip; client agreed.' : null,
      delay_max_minutes: sc.wasDelayed ?? sc.delayed ?? null,
      fleet_return_at: delivered && sc.returned !== false ? plus(deliveredAt, 90) : null,
      fleet_return_latitude: delivered && sc.returned !== false ? 14.4950 : null,
      fleet_return_longitude: delivered && sc.returned !== false ? 121.0410 : null,
    }
    const bookingId = await ins('bookings', 'booking_id', b)

    // destinations + cargo
    let weight = 0, volume = 0
    const dests = []
    for (const [s, place] of stops.entries()) {
      const destId = await ins('booking_destinations', 'destination_id', {
        booking_id: bookingId, address: place.a, latitude: place.lat, longitude: place.lng, sequence_order: s + 1,
        notes: s === 0 && n % 4 === 0 ? 'Receiving bay at the back; call the warehouse supervisor on arrival.' : null,
      })
      const qty = 20 + ((n + s) % 5) * 10
      const kg = qty * 6, cbm = +(qty * 0.03).toFixed(2)
      weight += kg; volume += cbm
      const useCatalog = sc.catalog && commodityIds.length && productIds.length
      const itemId = await ins('booking_cargo_items', 'item_id', {
        booking_id: bookingId, destination_id: destId, quantity: qty, weight_kg: kg, volume_cbm: cbm,
        length_cm: 40 + s * 10, width_cm: 30, height_cm: 25,
        commodity_id: useCatalog ? pick(commodityIds, s) : null, commodity_text: useCatalog ? null : pick(COMMODITIES, n + s),
        product_id: useCatalog ? pick(productIds, s) : null, product_text: useCatalog ? null : pick(PRODUCTS, n + s),
        shc_id: useCatalog && codeIds.length ? codeIds[0] : null, shc_text: useCatalog ? null : 'GEN',
        notes: s === 1 ? 'Fragile, do not double-stack' : null,
      })
      dests.push({ destId, itemId, qty, place })
    }
    await upd('bookings', 'booking_id', bookingId, { required_weight_kg: weight, required_volume_cbm: +volume.toFixed(2), required_net_weight_kg: Math.round(weight * 0.92) })

    const revisions = sc.resubmitted === true ? 1 : sc.resubmitted || 0
    for (let rv = 1; rv <= revisions; rv++) {
      await ins('booking_revisions', 'revision_id', {
        booking_id: bookingId, revision_number: rv, resubmitted_by: client.id, created_at: ago(60 * (5 + (revisions - rv) * 24)),
        before_snapshot: { schedule_date: phDay(1 + rv), origin: origin.a, rejection_reason: pick(['Drop-off address is incomplete', 'Cargo exceeds what the client declared; please split the booking', 'Route not serviceable on the requested date'], rv) },
        after_snapshot: { schedule_date: sched, origin: origin.a },
      })
    }

    const rec = { n, label: sc.label, bookingId, status: sc.status, sched, client, mainD, mainT, secondD, vendor, dests, sc }
    scenarioRows.push(rec)
    if (!crewed) continue

    // delivery + crew rows
    const deliveryStatus = sc.status === 'assigned' ? 'pending' : sc.status === 'in_transit' ? 'in_transit' : 'delivered'
    const deliveryId = await ins('deliveries', 'delivery_id', vendor ? {
      booking_id: bookingId, driver_id: null, truck_id: null, status: deliveryStatus, is_vendor_supplied: true,
      vendor_name: 'JRS Trucking Services', vendor_contact: '0918 555 0101', vendor_driver_name: nameOf(vendor),
      vendor_driver_license: `V${10 + vendor.i}-25-${pad(vendor.i + 1, 6)}`, vendor_driver_phone: null,
      vendor_vehicle_plate: `VND ${2000 + n}`, vendor_vehicle_type: 'Closed Van', vendor_driver_email: vendor.email,
      vendor_driver_user_id: vendor.id,
      pickup_time: sc.status === 'assigned' ? null : plus(doneBase, 30), delivery_time: deliveredAt,
    } : {
      booking_id: bookingId, driver_id: mainD.driver_id, truck_id: mainT.id, status: deliveryStatus,
      second_driver_id: secondD?.driver_id ?? null,
      helper_name: sc.helper ? `${pick(FIRST, n + 11)} ${pick(LAST, n + 7)}` : null,
      pickup_time: sc.status === 'assigned' ? null : plus(doneBase, 30), delivery_time: deliveredAt,
    })
    for (const d of dests) await upd('booking_destinations', 'destination_id', d.destId, { delivery_id: deliveryId })
    await ins('driver_assignments', 'assignment_id', { booking_id: bookingId, driver_id: (vendor ?? mainD).driver_id, assigned_by: ops.id, crew_role: 'lead', assigned_at: assignedAt })
    if (secondD) await ins('driver_assignments', 'assignment_id', { booking_id: bookingId, driver_id: secondD.driver_id, assigned_by: ops.id, crew_role: 'second', assigned_at: assignedAt })
    if (mainT) await ins('truck_assignments', 'assignment_id', { booking_id: bookingId, truck_id: mainT.id, assigned_by: ops.id, assigned_at: assignedAt })

    // trips, stops, cargo, milestones, proofs
    const nTrips = sc.trips ?? 1
    const onRoad = sc.status === 'in_transit'
    const depart = onRoad ? agoR(150) : sc.phase === 'done' ? doneBase : at(sched, callTime)
    const startedAt = onRoad ? agoR(sc.phase === 'loading' ? 25 : 140) : plus(doneBase, 0)
    const pickupAt = onRoad ? agoR(100) : plus(doneBase, 50)
    const lead = vendor ?? mainD
    rec.trips = []
    rec.stops = []
    for (let t = 1; t <= nTrips; t++) {
      // trip state
      let tripStatus = 'pending'
      if (sc.phase === 'done') tripStatus = 'completed'
      else if (sc.phase === 'trip2') tripStatus = t === 1 ? 'completed' : 'in_transit'
      else if (onRoad) tripStatus = t === 1 ? 'in_transit' : 'pending'
      const tripOffset = (t - 1) * 240
      const loaded = tripStatus === 'completed' || (tripStatus === 'in_transit' && sc.phase !== 'loading')
      const tPickup = sc.phase === 'trip2' && t === 2 ? ago(70) : sc.phase === 'trip2' ? agoR(260) : plus(pickupAt, tripOffset)
      const tripId = await ins('booking_trips', 'trip_id', {
        booking_id: bookingId, trip_number: t, status: tripStatus,
        planned_departure_at: plus(depart, tripOffset), planned_arrival_at: plus(depart, tripOffset + 60 * (1 + nStops)),
        planned_return_at: t === nTrips ? plus(depart, tripOffset + 60 * (2 + nStops)) : null,
        pickup_proof_photo_url: loaded ? FILES.pickup.ref : null, pickup_proof_at: loaded ? tPickup : null,
        pickup_proof_latitude: loaded ? origin.lat : null, pickup_proof_longitude: loaded ? origin.lng : null,
        pickup_proof_accuracy_m: loaded ? 8 : null, pickup_proof_distance_m: loaded ? 24 : null,
        pickup_confirmed_by: loaded && !sc.officeConfirm ? lead.driver_id : null,
        pickup_proof_override_reason: loaded && sc.officeConfirm && sc.phase === 'done' ? 'Confirmed by the office: driver phone died; warehouse confirmed loading by phone' : null,
        notes: nTrips > 1 ? `Run ${t} of ${nTrips}: half the load` : null,
      })
      rec.trips.push(tripId)
      if (t === 1 && loaded) {
        await upd('bookings', 'booking_id', bookingId, { pickup_proof_photo_url: FILES.pickup.ref, pickup_proof_at: tPickup, pickup_proof_latitude: origin.lat, pickup_proof_longitude: origin.lng })
      }
      // pickup milestones
      if (tripStatus !== 'pending') {
        await ins('stop_milestones', 'milestone_id', { booking_id: bookingId, trip_id: tripId, trip_stop_id: null, stage: 'arrived', at: plus(tPickup, -40), source: 'driver', driver_id: lead.driver_id, latitude: origin.lat, longitude: origin.lng, accuracy_m: 10 })
        await ins('stop_milestones', 'milestone_id', { booking_id: bookingId, trip_id: tripId, trip_stop_id: null, stage: 'started', at: plus(tPickup, -30), source: 'driver', driver_id: lead.driver_id })
        if (loaded && !sc.oldApp) await ins('stop_milestones', 'milestone_id', { booking_id: bookingId, trip_id: tripId, trip_stop_id: null, stage: 'finished', at: plus(tPickup, -4), source: 'driver', driver_id: lead.driver_id })
      }
      for (const [s, d] of dests.entries()) {
        // how far along this trip is
        let stopStatus = 'pending'
        if (tripStatus === 'completed') stopStatus = sc.failed === 'all' || (sc.failed === 'one' && s === dests.length - 1) ? 'failed' : 'delivered'
        else if (tripStatus === 'in_transit' && sc.phase === 'midway' && s === 0) stopStatus = 'delivered'
        else if (tripStatus === 'in_transit' && sc.phase === 'trip2' && t === 2 && s === 0) stopStatus = 'pending'
        const planned = onRoad && tripStatus === 'in_transit'
          ? (sc.delayed && s === (sc.phase === 'midway' ? 1 : 0) ? ago(sc.delayed + 30) : plus(NOW, 60 + s * 60))
          : plus(depart, tripOffset + 60 * (1 + s))
        const deliveredStopAt = stopStatus === 'delivered'
          ? (onRoad && tripStatus === 'in_transit' ? agoR(35) : plus(tPickup, 60 * (1 + s)))
          : stopStatus === 'failed' ? plus(tPickup, 60 * (1 + s)) : null
        const office = sc.officeConfirm && stopStatus === 'delivered' && (sc.phase === 'done' || s === 0)
        const failReason = sc.failed === 'all' ? 'Failed — reported by the office: Goods stolen: truck was held up at a stoplight; police report filed'
          : 'Failed — reported by the office: Client refused the delivery: receiver said the PO was cancelled'
        const stopId = await ins('booking_trip_stops', 'trip_stop_id', {
          trip_id: tripId, destination_id: d.destId, sequence_order: s + 1, status: stopStatus,
          delivered_at: deliveredStopAt, planned_arrival_at: planned,
          proof_photo_url: stopStatus === 'delivered' && !office ? pick([FILES.dropoff.ref, FILES.dropoff2.ref], s) : null,
          proof_at: deliveredStopAt, proof_latitude: stopStatus === 'delivered' ? d.place.lat : null, proof_longitude: stopStatus === 'delivered' ? d.place.lng : null,
          proof_accuracy_m: stopStatus === 'delivered' && !office ? 9 : null, proof_distance_m: stopStatus === 'delivered' && !office ? 31 : null,
          proof_override_reason: office ? 'Confirmed by the office: receiver emailed the signed DR; driver had no signal' : stopStatus === 'failed' ? failReason : null,
          confirmed_by: stopStatus === 'delivered' && !office ? lead.driver_id : null,
        })
        if (t === 1) rec.stops.push(stopId)
        await ins('booking_trip_cargo', 'trip_cargo_id', {
          booking_id: bookingId, trip_id: tripId, trip_stop_id: stopId, item_id: d.itemId,
          planned_qty: nTrips > 1 ? d.qty / 2 : d.qty, loaded_qty: loaded ? (nTrips > 1 ? d.qty / 2 : d.qty) : null,
        })
        // arrival + start at a stop the truck reached
        if (stopStatus !== 'pending' || (tripStatus === 'in_transit' && sc.phase === 'midway' && s === 1)) {
          const arr = stopStatus === 'pending' ? agoR(8) : plus(deliveredStopAt, -35)
          await ins('stop_milestones', 'milestone_id', { booking_id: bookingId, trip_id: tripId, trip_stop_id: stopId, stage: 'arrived', at: arr, source: office ? 'staff' : 'driver', driver_id: office ? null : lead.driver_id, corrected_by: office ? ME.id : null, corrected_at: office ? NOW : null, correction_note: office ? 'Filled in from the warehouse log' : null })
          if (stopStatus !== 'pending' || s === 1) {
            await ins('stop_milestones', 'milestone_id', { booking_id: bookingId, trip_id: tripId, trip_stop_id: stopId, stage: 'started', at: plus(arr, 5), source: office ? 'staff' : 'driver', driver_id: office ? null : lead.driver_id })
          }
          // "Unloading finished" comes right before the proof; an older app never sent it.
          if (stopStatus === 'delivered' && !sc.oldApp) {
            await ins('stop_milestones', 'milestone_id', { booking_id: bookingId, trip_id: tripId, trip_stop_id: stopId, stage: 'finished', at: plus(deliveredStopAt, -3), source: office ? 'staff' : 'driver', driver_id: office ? null : lead.driver_id })
          }
        }
        // destination roll-up (one trip carries everything when single-trip)
        if (t === nTrips && stopStatus !== 'pending') {
          await upd('booking_destinations', 'destination_id', d.destId, {
            status: stopStatus, delivered_at: stopStatus === 'delivered' ? deliveredStopAt : null,
            proof_photo_url: stopStatus === 'delivered' && !office ? FILES.dropoff.ref : null, proof_at: deliveredStopAt,
            proof_override_reason: office ? 'Confirmed by the office: receiver emailed the signed DR; driver had no signal' : stopStatus === 'failed' ? failReason : null,
          })
        }
        if (tripStatus === 'in_transit' && stopStatus === 'pending' && !rec.nextDest) rec.nextDest = d.destId
        if (t === 1 && sc.phase === 'midway' && s === 0) {
          await upd('booking_destinations', 'destination_id', d.destId, { status: 'delivered', delivered_at: deliveredStopAt, proof_photo_url: office ? null : FILES.dropoff.ref, proof_at: deliveredStopAt, proof_override_reason: office ? 'Confirmed by the office: receiver emailed the signed DR; driver had no signal' : null })
        }
      }
    }

    // odometer before/after the job (Fleet Manager)
    if (mainT && sc.status !== 'assigned') {
      await ins('truck_odometer_readings', 'reading_id', { truck_id: mainT.id, reading_km: mainT.odo - 180, kind: 'pre_trip', photo_url: FILES.odometer.ref, booking_id: bookingId, recorded_by: pick(fleets, n).id, recorded_at: plus(startedAt, -30) })
      if (b.fleet_return_at) await ins('truck_odometer_readings', 'reading_id', { truck_id: mainT.id, reading_km: mainT.odo, kind: 'post_trip', photo_url: FILES.odometer.ref, booking_id: bookingId, recorded_by: pick(fleets, n).id, recorded_at: plus(b.fleet_return_at, 20) })
    }

    // who drove when
    if (sc.status !== 'assigned') {
      const leadId = lead.driver_id
      const shiftEnd = delivered ? (b.fleet_return_at ?? null) : null
      if (sc.wheel === 'switch') {
        // "I'm taking the wheel": the second driver took over an hour ago
        await ins('booking_driving_shifts', 'shift_id', { booking_id: bookingId, driver_id: leadId, started_at: startedAt, ended_at: ago(60), source: 'start', latitude: origin.lat, longitude: origin.lng })
        await ins('booking_driving_shifts', 'shift_id', { booking_id: bookingId, driver_id: secondD.driver_id, started_at: ago(60), source: 'switch' })
      } else if (sc.wheel === 'staff') {
        // seats already swapped above: the one who started is now the second driver
        await ins('booking_driving_shifts', 'shift_id', { booking_id: bookingId, driver_id: secondD.driver_id, started_at: startedAt, ended_at: ago(60), source: 'start', latitude: origin.lat, longitude: origin.lng })
        await ins('booking_driving_shifts', 'shift_id', { booking_id: bookingId, driver_id: leadId, started_at: ago(60), source: 'staff', recorded_by: ops.id })
        await ins('booking_crew_swaps', 'swap_id', {
          booking_id: bookingId, old_lead_driver_id: secondD.driver_id, new_lead_driver_id: leadId, swapped_at: ago(60), swapped_by: ops.id,
          reason: sc.lateConfirm ? 'Main driver phone died; second driver takes over the stops.' : 'Main driver felt unwell; second driver takes the wheel.',
        })
      } else if (!sc.crewReplaced) {
        await ins('booking_driving_shifts', 'shift_id', { booking_id: bookingId, driver_id: leadId, started_at: startedAt, ended_at: shiftEnd ?? (delivered ? deliveredAt : null), source: 'start', latitude: origin.lat, longitude: origin.lng })
      }
    }

    // live position for the map
    if (onRoad && !(sc.pause === 'closed_tbc')) {
      const posDriver = (rec.mainD ?? vendor).driver_id
      const nextPlace = dests.find((d) => d.destId === rec.nextDest)?.place ?? dests[0].place
      // From the last place reached (origin, or the drop-off just done) toward the next one.
      const from = sc.phase === 'midway' ? dests[0].place : origin
      const f = sc.phase === 'loading' ? 0 : 0.55
      const lat = from.lat + (nextPlace.lat - from.lat) * f, lng = from.lng + (nextPlace.lng - from.lng) * f
      const fixAt = sc.noSignal ? ago(48) : ago(1)
      for (let k = 12; k >= 1; k--) {
        const g = f * (1 - k / 13)
        await ins('driver_location_history', 'location_id', {
          driver_id: posDriver, booking_id: bookingId, latitude: from.lat + (nextPlace.lat - from.lat) * g, longitude: from.lng + (nextPlace.lng - from.lng) * g,
          accuracy_m: 6 + (k % 5), speed_mps: sc.phase === 'loading' ? 0 : 9 + (k % 4), heading_deg: 45, recorded_at: plus(fixAt, -k * 4),
        })
      }
      await db.query(
        `insert into driver_locations (driver_id, booking_id, latitude, longitude, accuracy_m, speed_mps, heading_deg, recorded_at)
         values ($1,$2,$3,$4,8,$5,45,$6)`,
        [posDriver, bookingId, lat, lng, sc.pause || sc.breakdown ? 0 : 11, fixAt.toISOString()],
      )
      track('driver_locations', posDriver)
    }
  }

  // ---------------------------------------------------- the special scenarios
  const byLabel = (prefix) => scenarioRows.find((r) => r.label.startsWith(prefix))
  // delay flags
  for (const r of scenarioRows.filter((r) => r.sc.delayed)) {
    await upd('bookings', 'booking_id', r.bookingId, {
      delayed_since: ago(r.sc.delayed - 15), delay_minutes: r.sc.delayed, delay_notified_minutes: r.sc.delayed,
      delay_expected_at: r.sc.noSignal ? null : plus(NOW, 20), delay_destination_id: r.nextDest ?? r.dests[0].destId,
      delay_max_minutes: r.sc.delayed,
    })
  }
  // pauses
  const pauseSpec = {
    weather_set: { reason: 'weather', note: 'Typhoon signal no. 2 over Cavite; the driver is parked at a gasoline station.', date: phDay(1), time: '07:00' },
    closed_tbc:  { reason: 'dropoff_closed', note: 'Receiving bay closed for inventory; client will advise the new day.', date: null, time: null },
    overdue:     { reason: 'road_closed', note: 'Road closed by a landslide; continuing once cleared.', date: phDay(0), time: (() => { const h = new Date(Date.now() + 8 * HOUR - 2 * HOUR).getUTCHours(); return `${pad(h, 2)}:00` })() },
  }
  for (const r of scenarioRows.filter((r) => r.sc.pause)) {
    const p = pauseSpec[r.sc.pause]
    const pausedAt = r.sc.pause === 'weather_set' ? ago(90) : ago(60 * 20)
    const by = pick(opss, r.n)
    await ins('booking_pauses', 'pause_id', {
      booking_id: r.bookingId, trip_id: r.trips[0], reason: p.reason, note: p.note, paused_by: by.id, paused_at: pausedAt,
      latitude: 14.43, longitude: 120.94, accuracy_m: 12, expected_resume_date: p.date, expected_resume_call_time: p.time,
      expected_resume_set_by: p.date ? by.id : null, expected_resume_set_at: p.date ? plus(pausedAt, 10) : null,
    })
    await upd('bookings', 'booking_id', r.bookingId, { paused_at: pausedAt, pause_reason: p.reason, pause_note: p.note })
  }
  // a finished booking that was paused once
  const pastPause = byLabel('Completed, was paused')
  await ins('booking_pauses', 'pause_id', {
    booking_id: pastPause.bookingId, trip_id: pastPause.trips[0], reason: 'pickup_closed', note: 'Warehouse opened late (power outage).',
    paused_by: opss[0].id, paused_at: at(pastPause.sched, '08:20'), resumed_at: at(pastPause.sched, '10:05'), resumed_by: opss[0].id,
    resumed_via: 'staff', resume_note: 'Warehouse open again; loading resumed.',
  })

  // breakdowns
  for (const r of scenarioRows.filter((r) => r.sc.breakdown)) {
    const place = PLACES[10]
    const reportId = await ins('driver_reports', 'report_id', {
      driver_id: r.mainD.driver_id, booking_id: r.bookingId, truck_id: r.mainT.id, source: 'detailed', incident_type: 'vehicle_breakdown',
      description: 'Engine stalled on Aguinaldo Highway and will not restart; hazard lights on, cargo intact.',
      photo_urls: [FILES.report.ref], latitude: place.lat, longitude: place.lng, accuracy_m: 9, address: place.a,
      trip_can_continue: false, status: r.sc.breakdown === 'paused' ? 'acknowledged' : 'reported', speed_kmh: 0,
      acknowledged_by: r.sc.breakdown === 'paused' ? opss[0].id : null, acknowledged_at: r.sc.breakdown === 'paused' ? ago(30) : null,
      blowbagets_check: { engine: false, battery: true }, created_at: ago(40),
    })
    reportIds.push(reportId)
    await upd('trucks', 'truck_id', r.mainT.id, {
      status: 'under_maintenance', maintenance_reason: 'breakdown', maintenance_since: ago(40), maintenance_booking_id: r.bookingId,
      maintenance_report_id: reportId, maintenance_note: 'Engine stalled, will not restart',
    })
    r.mainT.status = 'under_maintenance'
    if (r.sc.breakdown === 'pending') {
      await upd('bookings', 'booking_id', r.bookingId, { breakdown_reported_at: ago(40), breakdown_report_id: reportId, breakdown_note: 'Engine stalled on Aguinaldo Highway and will not restart' })
    } else {
      await ins('booking_pauses', 'pause_id', {
        booking_id: r.bookingId, trip_id: r.trips[0], reason: 'vehicle_breakdown', note: 'Engine stalled; waiting for a replacement vehicle.',
        paused_by: opss[0].id, paused_at: ago(30), report_id: reportId, latitude: place.lat, longitude: place.lng,
      })
      await upd('bookings', 'booking_id', r.bookingId, { paused_at: ago(30), pause_reason: 'vehicle_breakdown', pause_note: 'Engine stalled; waiting for a replacement vehicle.' })
    }
  }

  // crew replacement after a breakdown: old crew off, new crew on, the load still to be moved
  {
    const r = byLabel('In transit, crew replaced')
    const oldD = r.mainD, oldT = r.mainT
    const newIdx = livePtr++
    const newD = drivers[newIdx], newT = trucks[newIdx]
    liveDrivers.add(newD.driver_id); liveTrucks.add(newT.id)
    const place = PLACES[2]
    const reportId = await ins('driver_reports', 'report_id', {
      driver_id: oldD.driver_id, booking_id: r.bookingId, truck_id: oldT.id, source: 'detailed', incident_type: 'vehicle_breakdown',
      description: 'Clutch failed near C5; vehicle cannot move.', photo_urls: [FILES.report.ref], latitude: place.lat, longitude: place.lng,
      address: place.a, trip_can_continue: false, status: 'resolved', acknowledged_by: opss[0].id, acknowledged_at: ago(110),
      resolved_by: opss[0].id, resolved_at: ago(45), resolution_note: 'Replacement vehicle and driver sent', created_at: ago(120),
    })
    const pauseId = await ins('booking_pauses', 'pause_id', {
      booking_id: r.bookingId, trip_id: r.trips[0], reason: 'vehicle_breakdown', note: 'Clutch failed; replacement vehicle on the way.',
      paused_by: opss[0].id, paused_at: ago(110), report_id: reportId, resumed_at: ago(40), resumed_by: opss[0].id, resumed_via: 'staff',
      resume_note: 'Replacement crew on site.',
    })
    await ins('crew_replacements', 'replacement_id', {
      booking_id: r.bookingId, trip_id: r.trips[0], pause_id: pauseId, report_id: reportId,
      old_driver_id: oldD.driver_id, old_truck_id: oldT.id, old_vehicle_plate: oldT.plate,
      new_driver_id: newD.driver_id, new_truck_id: newT.id, new_vehicle_plate: newT.plate,
      reason_note: 'Original vehicle broke down (clutch). Replacement sent from the yard.',
      handover_latitude: place.lat, handover_longitude: place.lng, transfer_required: true,
      replaced_by: opss[0].id, replaced_by_role: 'operations_manager', replaced_at: ago(45),
    })
    await db.query(`update deliveries set driver_id = $2, truck_id = $3 where booking_id = $1`, [r.bookingId, newD.driver_id, newT.id])
    await db.query(`update driver_assignments set driver_id = $2 where booking_id = $1 and crew_role = 'lead'`, [r.bookingId, newD.driver_id])
    await ins('truck_assignments', 'assignment_id', { booking_id: r.bookingId, truck_id: newT.id, assigned_by: opss[0].id, assigned_at: ago(45) })
    await ins('booking_driving_shifts', 'shift_id', { booking_id: r.bookingId, driver_id: oldD.driver_id, started_at: ago(140), ended_at: ago(45), source: 'start' })
    await ins('booking_driving_shifts', 'shift_id', { booking_id: r.bookingId, driver_id: newD.driver_id, started_at: ago(45), source: 'staff', recorded_by: opss[0].id })
    await db.query(`update driver_locations set driver_id = $2 where driver_id = $1`, [oldD.driver_id, newD.driver_id])
    manifest.tables.driver_locations = manifest.tables.driver_locations.map((id) => (id === oldD.driver_id ? newD.driver_id : id))
    await upd('trucks', 'truck_id', oldT.id, { status: 'under_maintenance', maintenance_reason: 'breakdown', maintenance_since: ago(120), maintenance_booking_id: r.bookingId, maintenance_report_id: reportId, maintenance_note: 'Clutch failed' })
    oldT.status = 'under_maintenance'
    liveDrivers.delete(oldD.driver_id)
  }

  // a drop-off the old main driver confirmed offline, received after the office swapped the drivers
  {
    const r = byLabel('In transit, late drop-off confirmation')
    const old = r.secondD   // seats were swapped: the second driver now is the one who confirmed
    const place = r.dests[0].place
    await ins('late_confirmations', 'late_id', {
      booking_id: r.bookingId, kind: 'dropoff', trip_id: r.trips[0], trip_stop_id: r.stops[0],
      driver_id: old.driver_id, driver_user_id: old.id, confirmed_at: ago(75), received_at: ago(20),
      proof_photo_url: FILES.dropoff.ref, latitude: place.lat + 0.003, longitude: place.lng, accuracy_m: 12, distance_m: 340,
      override_reason: 'Receiver asked us to unload at the side gate', reasons: ['too_far'], status: 'pending', created_at: ago(20),
    })
  }

  // a past breakdown that left vehicle 15's twin under maintenance is covered by TRUCK[15];
  // vehicle 12 came back from a delivered job (recheck due): point it at one.
  {
    const r = byLabel('Delivered, waiting for the client')
    await ins('truck_odometer_readings', 'reading_id', { truck_id: trucks[12].id, reading_km: trucks[12].odo, kind: 'post_trip', booking_id: r.bookingId, photo_url: FILES.odometer.ref, recorded_by: fleets[0].id, recorded_at: ago(30) })
  }

  if (livePtr !== LIVE_START + LIVE_COUNT || secondPtr !== SECOND_START + SECOND_COUNT) {
    throw new Error(`crew pools off: live ${livePtr}/${LIVE_START + LIVE_COUNT}, second ${secondPtr}/${SECOND_START + SECOND_COUNT}`)
  }

  // ------------------------------------------------- driver / vehicle states
  for (const id of liveDrivers) await db.query(`update drivers set status = 'assigned' where driver_id = $1`, [id])
  for (const t of trucks) if (liveTrucks.has(t.id) && t.status === 'available') await db.query(`update trucks set status = 'in_use' where truck_id = $1`, [t.id])

  // Rewind nothing: real booking numbers continue after the seeded ones.
  const refs = (await db.query(`select reference_number from bookings where booking_id = any($1) order by reference_number`, [scenarioRows.map((r) => r.bookingId)])).rows
  const counterAfter = (await db.query(`select period, last_value from booking_reference_counters`)).rows
  manifest.counter_before = counterBefore
  manifest.counter_after = counterAfter

  // ---------------------------------------------------------- driver reports
  const INCIDENTS = ['accident', 'vehicle_breakdown', 'health_emergency', 'security_threat']
  const onRoadRows = scenarioRows.filter((r) => r.status === 'in_transit' && r.mainD)
  for (let i = 0; i < 20; i++) {
    const status = pick(['reported', 'acknowledged', 'resolved', 'resolved'], i)
    const place = pick(PLACES, i)
    const d = drivers[LIVE_START + (i % LIVE_COUNT)], t = trucks[LIVE_START + (i % LIVE_COUNT)]
    const quick = i % 5 === 0
    const linked = i < 8 ? pick(onRoadRows, i) : null
    const rid = await ins('driver_reports', 'report_id', {
      driver_id: linked ? linked.mainD.driver_id : d.driver_id, booking_id: linked?.bookingId ?? null, truck_id: linked ? linked.mainT.id : t.id,
      source: quick ? 'quick' : 'detailed', incident_type: quick && i % 10 === 0 ? null : pick(INCIDENTS, i),
      description: quick ? null : pick(['Flat tyre on SLEX southbound', 'Minor side-swipe at the loading bay, no injuries', 'Driver felt dizzy, resting at a gasoline station', 'A motorcycle has been following the truck since Bicutan', 'Battery warning light on'], i),
      photo_urls: quick ? [] : [FILES.report.ref], latitude: place.lat, longitude: place.lng, accuracy_m: 10, address: place.a,
      trip_can_continue: quick ? null : i % 3 !== 0, status, speed_kmh: quick ? 42 : null,
      acknowledged_by: status === 'reported' ? null : pick(opss, i).id, acknowledged_at: status === 'reported' ? null : ago(60 * (i + 1)),
      resolved_by: status === 'resolved' ? pick(opss, i).id : null, resolved_at: status === 'resolved' ? ago(60 * i) : null,
      resolution_note: status === 'resolved' ? pick(['Tyre changed, trip resumed', 'Driver cleared to continue after rest', 'Reported to the police; escort arranged'], i) : null,
      created_at: ago(60 * (i * 5 + 2)),
    })
    // SOS calls on the quick alerts (never 'ringing': that would ring real browsers)
    if (quick) {
      const callStatus = pick(['answered', 'missed', 'fell_back', 'ended'], i / 5)
      const answerer = pick(opss, i)
      await ins('emergency_calls', 'call_id', {
        report_id: rid, driver_id: linked ? linked.mainD.driver_id : d.driver_id, booking_id: linked?.bookingId ?? null,
        room_name: `seed-sos-${crypto.randomUUID()}`, status: callStatus, rung_user_ids: opss.slice(0, 4).map((p) => p.id).concat(admins.slice(0, 2).map((p) => p.id)),
        answered_by: ['answered', 'ended'].includes(callStatus) ? answerer.id : null, answered_at: ['answered', 'ended'].includes(callStatus) ? ago(60 * (i * 5 + 2) - 1) : null,
        ended_by: callStatus === 'ended' || callStatus === 'answered' ? answerer.id : null, ended_at: callStatus === 'missed' ? null : ago(60 * (i * 5 + 2) - 4),
        end_reason: { answered: 'hangup', ended: 'hangup', missed: null, fell_back: 'no_answer' }[callStatus], created_at: ago(60 * (i * 5 + 2)),
      })
    }
  }

  // --------------------------------------------------------------- documents
  const docRows = scenarioRows.filter((r) => ['delivered', 'completed'].includes(r.status))
  let docs = 0
  for (const c of clients.slice(0, 8)) {
    const status = pick(['approved', 'approved', 'pending', 'rejected', 'archived'], c.i)
    await ins('documents', 'document_id', {
      client_id: c.client_id, document_type: 'contract', file_url: FILES.contract.ref, original_name: `Service-Agreement-${pad(c.i + 1)}.jpg`,
      file_format: 'jpg', bytes: FILES.contract.bytes, uploaded_by: pick(admins, c.i).id, status, uploaded_at: ago(60 * 24 * (c.i + 2)),
      reviewed_by: status === 'pending' ? null : pick(admins, c.i + 1).id, reviewed_at: status === 'pending' ? null : ago(60 * 24 * (c.i + 1)),
      rejection_reason: status === 'rejected' ? 'Last page unsigned; please re-scan with both signatures' : null,
      archived_at: status === 'archived' ? ago(60 * 24) : null, archived_by: status === 'archived' ? pick(admins, c.i).id : null,
      notes: c.i === 0 ? 'Renewal pending' : null,
    }); docs++
  }
  for (const [k, r] of docRows.entries()) {
    for (const type of k % 3 === 0 ? ['proof_of_delivery', 'other'] : ['proof_of_delivery']) {
      const status = pick(['approved', 'pending', 'approved', 'rejected', 'archived'], k)
      await ins('documents', 'document_id', {
        booking_id: r.bookingId, document_type: type, other_label: type === 'other' ? pick(['Gate Pass', 'Stock Transfer Slip', 'Sales Invoice'], k) : null,
        file_url: FILES.document.ref, original_name: `${type === 'other' ? 'Gate-Pass' : 'Signed-DR'}-${pad(k + 1)}.jpg`, file_format: 'jpg', bytes: FILES.document.bytes,
        uploaded_by: pick(opss, k).id, status, uploaded_at: ago(60 * (k * 7 + 3)),
        reviewed_by: status === 'pending' ? null : pick(admins, k).id, reviewed_at: status === 'pending' ? null : ago(60 * (k * 7 + 1)),
        rejection_reason: status === 'rejected' ? 'Blurry scan; the receiver signature cannot be read' : null,
        archived_at: status === 'archived' ? ago(60 * 5) : null, archived_by: status === 'archived' ? pick(admins, k).id : null,
      }); docs++
    }
  }

  // vehicle papers (Fleet folder): registration, insurance, other
  for (const [k, [type, label, status]] of [
    ['vehicle_registration', null, 'approved'], ['vehicle_insurance', null, 'pending'],
    ['other', 'Emission Test Certificate', 'rejected'], ['vehicle_registration', null, 'archived'],
  ].entries()) {
    const t = trucks[3 + k]
    await ins('documents', 'document_id', {
      truck_id: t.id, document_type: type, other_label: label, file_url: FILES.document.ref,
      original_name: `${type === 'vehicle_insurance' ? 'Insurance' : type === 'other' ? 'Emission-Test' : 'OR-CR'}-${t.plate.replace(' ', '')}.jpg`,
      file_format: 'jpg', bytes: FILES.document.bytes, uploaded_by: pick(fleets, k).id, status, uploaded_at: ago(60 * 24 * (k + 1)),
      reviewed_by: status === 'pending' ? null : pick(admins, k).id, reviewed_at: status === 'pending' ? null : ago(60 * 24 * k + 60),
      rejection_reason: status === 'rejected' ? 'Wrong plate on the certificate; please upload the one for this vehicle' : null,
      archived_at: status === 'archived' ? ago(60 * 12) : null, archived_by: status === 'archived' ? pick(admins, k).id : null,
    }); docs++
  }

  // ----------------------------------------------------------- support tickets
  const CATS = ['booking', 'delivery', 'tracking', 'documents', 'account', 'other']
  const SUBJ = ['Where is my delivery?', 'Need a copy of the signed DR', 'Cannot change my company name', 'Wrong drop-off address on my booking', 'Driver arrived earlier than the call time', 'How do I renew our contract?']
  for (let i = 0; i < 20; i++) {
    const c = pick(bookingClients, i * 3)
    const resolved = i % 3 === 0
    const byStaff = i % 7 === 0
    const r = scenarioRows.find((x) => x.client.client_id === c.client_id)
    await ins('support_tickets', 'ticket_id', {
      client_id: c.client_id, opened_by: byStaff ? pick(admins, i).id : c.id, booking_id: i % 2 === 0 ? r?.bookingId ?? null : null,
      category: pick(CATS, i), subject: pick(SUBJ, i),
      message: byStaff ? 'Client called the office: they want a copy of the delivery receipt sent to their accounting team.' : 'Hello, I need help with this. Please get back to me by email. Thank you.',
      chat_transcript: JSON.stringify(byStaff ? [] : [
        { role: 'user', text: pick(SUBJ, i), at: ago(60 * (i * 3 + 3)) },
        { role: 'assistant', text: 'I could not find an answer for that. Would you like to open a ticket?', at: ago(60 * (i * 3 + 3)) },
      ]),
      status: resolved ? 'resolved' : 'open', resolved_at: resolved ? ago(60 * i) : null, resolved_by: resolved ? pick(admins, i).id : null,
      resolution_note: resolved ? 'Replied by email with the requested details.' : null, created_at: ago(60 * (i * 3 + 2)),
    })
  }

  // --------------------------------------------------- password reset requests
  const resetPeople = [
    ...people.client.slice(9, 14), ...people.driver.slice(11, 17),
    ...people.admin.slice(2, 5), ...people.ops.slice(2, 5), ...people.fleet.slice(2, 4),
  ]
  for (const [i, p] of resetPeople.entries()) {
    const status = pick(['pending', 'sent', 'completed', 'cancelled', 'expired', 'pending', 'completed'], i)
    const method = i % 4 === 0 ? 'otp' : 'link'
    await ins('password_reset_requests', 'request_id', {
      user_id: p.id, email: p.email, requested_role: p.role,
      handler_group: p.role === 'client' || p.role === 'driver' ? 'company_admin' : 'it_admin',
      status, delivery_method: method, created_at: ago(60 * (i * 2 + 1)),
      sent_by: ['sent', 'completed', 'expired'].includes(status) ? (p.role === 'client' || p.role === 'driver' ? ME.id : null) : null,
      sent_at: ['sent', 'completed', 'expired'].includes(status) ? ago(60 * (i * 2)) : null,
      token_hash: method === 'link' && ['sent', 'expired'].includes(status) ? crypto.randomBytes(32).toString('hex') : null,
      token_expires_at: method === 'link' && ['sent', 'expired'].includes(status) ? (status === 'expired' ? ago(60) : plus(NOW, 60 * 24)) : null,
      otp_hash: method === 'otp' && status === 'sent' ? crypto.randomBytes(30).toString('hex') : null,
      otp_expires_at: method === 'otp' && status === 'sent' ? plus(NOW, 10) : null, otp_sent_at: method === 'otp' && status === 'sent' ? ago(2) : null,
      completed_at: status === 'completed' ? ago(60 * (i * 2) - 30) : null,
    })
  }

  // ------------------------------------------------------------- notifications
  const NOTE = {
    client: [
      ['approved_gm', 'Booking approved', 'Your booking {ref} was approved.'], ['assigned', 'Driver assigned', 'A driver and vehicle are assigned to {ref}.'],
      ['delivery_started', 'Delivery started', 'Your delivery {ref} is on the way.'], ['delivery_delayed', 'Running late', '{ref} is running about 40 min late.'],
      ['delivery_confirm', 'Please confirm your delivery', '{ref} was delivered. Please confirm or report a problem.'], ['rejected_gm', 'Booking not approved', '{ref} was not approved.'],
      ['trip_paused', 'Delivery paused', '{ref} is paused: typhoon. New day: tomorrow 7:00 AM.'], ['delivery_incident', 'Problem on your delivery', 'A problem was reported on {ref}.'],
    ],
    driver: [
      ['assigned', 'New delivery', 'You are assigned to {ref}.'], ['driver_call_reminder', 'Call time in 1 hour', 'Be at the warehouse for {ref} by 6:00 AM.'],
      ['pause_continuation_driver', 'Continue tomorrow', '{ref} continues tomorrow at 7:00 AM.'], ['crew_replaced_on', 'You are now on a delivery', 'You replaced the crew on {ref}.'],
    ],
  }
  /** What the client would have been told so far, by where the booking is. */
  const clientNoticesFor = (r) => {
    const t = []
    if (r.sc.gm === 'rejected') t.push('rejected_gm')
    if (['approved', 'assigned', 'in_transit', 'delivered', 'completed'].includes(r.status) || (r.status === 'cancelled' && r.sc.gm === 'approved')) t.push('approved_gm')
    if (r.sc.phase) t.push('assigned')
    if (['in_transit', 'delivered', 'completed'].includes(r.status)) t.push('delivery_started')
    if (r.sc.delayed || r.sc.wasDelayed) t.push('delivery_delayed')
    if (r.sc.pause) t.push('trip_paused')
    if (r.sc.failed) t.push('delivery_incident')
    if (['delivered', 'completed'].includes(r.status)) t.push('delivery_confirm')
    return t.map((type) => NOTE.client.find((x) => x[0] === type))
  }
  let notes = 0
  for (const r of scenarioRows) {
    const row = (await db.query(`select reference_number from bookings where booking_id = $1`, [r.bookingId])).rows[0].reference_number
    for (const [k, [type, title, body]] of clientNoticesFor(r).entries()) {
      await ins('notifications', 'notification_id', { user_id: r.client.id, booking_id: r.bookingId, type, title, body: body.replace('{ref}', row), data: { reference_number: row }, created_at: ago(60 * (r.n + k)), read_at: (r.n + k) % 3 ? ago(30) : null }); notes++
    }
    const d = r.mainD ?? r.vendor
    if (d) for (const [k, [type, title, body]] of NOTE.driver.slice(0, 2).entries()) {
      await ins('notifications', 'notification_id', { user_id: d.id, booking_id: r.bookingId, type, title, body: body.replace('{ref}', row), data: { reference_number: row }, created_at: ago(60 * (r.n + k)), read_at: k ? null : ago(20) }); notes++
    }
  }

  // ------------------------------------------------------------------ messaging
  const said = [
    'Good morning! Is the delivery still on for today?', 'Yes, the driver is on the way.', 'Please call the warehouse supervisor when you arrive.',
    'Noted, thank you.', 'The bay is closed until 1 PM.', 'Okay, we will wait at the parking area.', 'Received the goods, all complete.', 'Thanks for the update!',
  ]
  const pairs = []
  for (let k = 0; k < 4; k++) pairs.push([pick(admins, k), clients[9 + k]])            // Company Administrator ↔ client
  for (let k = 0; k < 4; k++) pairs.push([pick(opss, k), clients[1 + k]])             // Operations Manager ↔ client
  for (let k = 0; k < 6; k++) pairs.push([pick(opss, k + 3), drivers[LIVE_START + k]]) // Operations Manager ↔ driver
  for (let k = 0; k < 3; k++) pairs.push([pick(fleets, k), drivers[LIVE_START + 6 + k]]) // Fleet Manager ↔ driver
  for (let k = 0; k < 3; k++) pairs.push([pick(admins, k + 2), pick(opss, k + 4)])    // staff ↔ staff
  let msgs = 0
  for (const [k, [a, b]] of pairs.entries()) {
    const convo = await ins('conversations', 'conversation_id', {
      participant_a_id: a.id, participant_b_id: b.id, context_type: 'direct', created_at: ago(60 * 24 * 3), last_message_at: ago(10 + k * 30),
      participant_a_last_read_at: ago(5 + k * 30), participant_b_last_read_at: k % 3 ? ago(10 + k * 30) : ago(60 * 24),
    })
    const r = scenarioRows.find((x) => x.client.client_id === b.client_id) ?? scenarioRows[k]
    const ref = (await db.query(`select reference_number from bookings where booking_id = $1`, [r.bookingId])).rows[0].reference_number
    let prev = null
    for (let m = 0; m < 4; m++) {
      const fromA = m % 2 === 0
      const content = m === 0 ? `Hi! About @${ref}: ${pick(said, k)}` : pick(said, k + m)
      const mid = await ins('messages', 'message_id', {
        sender_id: (fromA ? a : b).id, receiver_id: (fromA ? b : a).id, conversation_id: convo, content,
        sent_at: ago(10 + k * 30 + (3 - m) * 4), reply_to_message_id: m === 3 ? prev : null,
        message_type: m === 2 && k % 4 === 0 ? 'image' : 'text', attachment_url: m === 2 && k % 4 === 0 ? FILES.chat.ref : null,
        attachment_stamped: m === 2 && k % 8 === 0,
      }); msgs++
      if (m === 1 && k % 3 === 0) await ins('message_reactions', 'id', { message_id: mid, user_id: a.id, emoji: '👍' })
      prev = mid
    }
  }
  // groups: accepted, pending and declined invites; join notices; a reply, a reaction, a deleted and a hidden message
  const GROUPS = [
    { name: 'Dispatch Team', owner: opss[0], members: [opss[1], opss[2], fleets[0], ...drivers.slice(20, 26)], pending: [drivers[26]], declined: [drivers[27]] },
    { name: 'Management', owner: admins[0], members: [admins[1], admins[2], opss[0], fleets[0]], pending: [admins[3]], declined: [] },
    { name: 'South Luzon Runs', owner: opss[3], members: [opss[4], ...drivers.slice(30, 34)], pending: [], declined: [drivers[34]] },
  ]
  for (const [g, G] of GROUPS.entries()) {
    const gid = await ins('group_conversations', 'group_id', { name: G.name, created_by: G.owner.id, created_at: ago(60 * 24 * 5), last_message_at: ago(15 + g * 40) })
    await ins('group_members', 'id', { group_id: gid, user_id: G.owner.id, invited_by: G.owner.id, status: 'accepted', joined_at: ago(60 * 24 * 5), last_read_at: ago(15) })
    for (const m of G.members) await ins('group_members', 'id', { group_id: gid, user_id: m.id, invited_by: G.owner.id, status: 'accepted', joined_at: ago(60 * 24 * 4), last_read_at: ago(60 * (g + 1)) })
    for (const m of G.pending) await ins('group_members', 'id', { group_id: gid, user_id: m.id, invited_by: G.owner.id, status: 'pending' })
    for (const m of G.declined) await ins('group_members', 'id', { group_id: gid, user_id: m.id, invited_by: G.owner.id, status: 'declined' })
    let prev = null
    for (const [k, m] of G.members.slice(0, 3).entries()) {
      await ins('group_messages', 'message_id', { group_id: gid, sender_id: m.id, content: `${nameOf(m)} joined the group.`, message_type: 'system', meta: { event: 'joined' }, sent_at: ago(60 * 24 * 4 - k) }); msgs++
    }
    for (let k = 0; k < 8; k++) {
      const sender = k % 2 ? pick(G.members, k) : G.owner
      const mid = await ins('group_messages', 'message_id', {
        group_id: gid, sender_id: sender.id, content: pick(said, k + g), sent_at: ago(15 + g * 40 + (8 - k) * 6),
        reply_to_message_id: k === 5 ? prev : null, deleted_at: k === 6 ? ago(20) : null,
      }); msgs++
      if (k === 2) await ins('group_message_reactions', 'id', { message_id: mid, user_id: pick(G.members, 0).id, emoji: '✅' })
      if (k === 3) { await db.query(`insert into group_message_hidden (message_id, user_id) values ($1, $2)`, [mid, G.members[0].id]) }
      prev = mid
    }
    // member requests (a member asking the owner to add / remove someone)
    if (g === 0) {
      await ins('group_member_requests', 'request_id', { group_id: gid, requested_by: opss[1].id, target_user_id: drivers[28].id, action: 'add', status: 'pending' })
      await ins('group_member_requests', 'request_id', { group_id: gid, requested_by: opss[2].id, target_user_id: drivers[25].id, action: 'remove', status: 'declined', decided_by: opss[0].id, decided_at: ago(60) })
      await ins('group_member_requests', 'request_id', { group_id: gid, requested_by: opss[1].id, target_user_id: drivers[24].id, action: 'add', status: 'approved', decided_by: opss[0].id, decided_at: ago(120) })
    }
  }

  // ---------------------------------------------------------- logs + sign-ins
  const LOGIN = ['success', 'success', 'success', 'failed_password', 'failed_otp', 'failed_locked', 'failed_inactive', 'success', 'failed_permanently_locked']
  const everyone = Object.values(people).flat()
  for (let i = 0; i < 20; i++) {
    const p = pick(everyone, i * 7)
    const st = pick(LOGIN, i)
    await ins('login_history', 'id', {
      user_id: p.id, email: p.email, device_info: pick(['Chrome on Windows', 'Safari on iPhone', 'Edge on Windows', '8338 Driver app (Android)', 'Firefox on macOS'], i),
      user_agent: 'seed', location_city: pick(['Makati', 'Pasig', 'Quezon City', 'Imus', 'Calamba'], i), location_country: 'Philippines',
      attempt_status: st, failure_reason: st === 'success' ? null : pick(['Wrong password (3 attempts left)', 'Account status: inactive', 'Account locked for 25 more minutes'], i),
      created_at: ago(i * 37 + 5),
    })
  }
  const AUDIT = [
    ['booking', 'booking_created', 'Booking {ref} created by the client'], ['booking', 'booking_approved', 'Booking {ref} approved by the General Manager'],
    ['booking', 'booking_assigned', 'Driver and vehicle assigned to {ref}'], ['booking', 'trip_paused', '{ref} paused: weather'],
    ['booking', 'office_incident_reported', 'Incident on booking {ref} — Goods stolen'], ['user_management', 'user_created', 'Created a driver account'],
    ['user_management', 'user_archived', 'Archived a client account'], ['access_control', 'permissions_updated', 'Manage Access changed for an Operations Manager'],
    ['vehicle_activity', 'vehicle_updated', 'Vehicle status set to Under Maintenance'], ['vehicle_creation', 'vehicle_created', 'Vehicle added'],
    ['document_activity', 'document_approved', 'Proof of Delivery approved'], ['document_activity', 'document_rejected', 'Contract rejected: unsigned page'],
    ['data_export', 'export', 'Transaction History exported'], ['auth', 'login', 'Signed in'], ['driver_activity', 'trip_started', 'Start Navigation on {ref}'],
    ['delivery_activity', 'stop_confirmed', 'Drop-off confirmed on {ref}'], ['maintenance_activity', 'service_recorded', 'Service recorded: change oil'],
    ['admin_activity', 'contract_updated', 'Contract date saved for a client'],
  ]
  const staff = [...admins, ...opss, ...fleets]
  const allRefs = (await db.query(`select reference_number from bookings where booking_id = any($1)`, [scenarioRows.map((r) => r.bookingId)])).rows.map((r) => r.reference_number)
  for (let i = 0; i < 20; i++) {
    const [type, action, text] = pick(AUDIT, i)
    await ins('audit_logs', 'log_id', { user_id: pick(staff, i).id, log_type: type, action, description: text.replace('{ref}', pick(allRefs, i)), timestamp: ago(i * 23 + 3) })
  }
  const SYS = [
    ['info', 'cron_job', 'delay.scheduler', 'Delay check: 3 deliveries in transit, 1 flagged'], ['warn', 'external_api', 'maps.routes', 'Routes API slow (4.2 s)'],
    ['error', 'server_error', 'booking.service', 'Unhandled error while reading a booking'], ['info', 'email_event', 'brevo', 'Reminder email sent'],
    ['critical', 'db_event', 'database', 'Connection pool exhausted for 12 s'], ['warn', 'auth_event', 'auth.service', 'Failed password login'],
    ['warn', 'external_api', 'tracking.device', 'Phone silent for 14 min while in transit: no location fixes (battery optimisation?)'],
    ['error', 'email_event', 'brevo', 'Email to a client bounced'], ['info', 'cron_job', 'contract-expiry.scheduler', 'Contract reminders: 2 sent'],
  ]
  for (let i = 0; i < 20; i++) {
    const [level, ev, source, message] = pick(SYS, i)
    await ins('system_logs', 'log_id', { log_level: level, event_type: ev, source, message, metadata: { seed: true }, resolved: level === 'info' || i % 4 === 0, timestamp: ago(i * 29 + 4) })
  }

  // ---------------------------------------------------------------- report
  const counts = Object.entries(manifest.tables).map(([t, ids]) => [t, ids.length]).sort((a, b) => b[1] - a[1])
  console.log('\nRows per table:')
  for (const [t, n] of counts) console.log(`  ${t.padEnd(30)} ${n}`)
  console.log(`  ${'auth users'.padEnd(30)} ${manifest.auth_user_ids.length}`)
  console.log(`  ${'stored files'.padEnd(30)} ${manifest.files.length}`)
  console.log('\nBooking scenarios:')
  const refById = Object.fromEntries((await db.query(`select booking_id, reference_number from bookings where booking_id = any($1)`, [scenarioRows.map((r) => r.bookingId)])).rows.map((r) => [r.booking_id, r.reference_number]))
  for (const r of scenarioRows) if (!r.label.includes('(fill)')) console.log(`  ${refById[r.bookingId]}  ${r.label}`)
  manifest.scenarios = scenarioRows.map((r) => ({ ref: refById[r.bookingId], label: r.label, client: r.client.email, driver: (r.mainD ?? r.vendor)?.email ?? null }))

  if (DRY) {
    await db.query('ROLLBACK')
    console.log('\nDRY RUN — database rolled back.')
  } else {
    await db.query('COMMIT')
    saveManifest()
    console.log(`\nCommitted. Manifest: ${MANIFEST}`)
    console.log(`Shared password for every seeded account: ${PASSWORD}`)
  }
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('\nSeed failed; database rolled back.')
  console.error(err)
  process.exitCode = 1
} finally {
  db.release()
  await pool.end()
  if (DRY || process.exitCode) await removeAuthAndFiles()
  if (!DRY && process.exitCode) { try { fs.unlinkSync(MANIFEST) } catch {} }
}
