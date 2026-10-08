/**
 * Fresh-start wipe: every booking, every vehicle and vehicle model, every
 * notification, and the audit / system / login logs.
 *
 *   node scripts/purge-bookings-vehicles-notifications-logs.mjs --dry-run   # report only, rolls back
 *   node scripts/purge-bookings-vehicles-notifications-logs.mjs            # delete
 *
 * Survives: users, clients, drivers (an 'assigned' driver goes back to
 * 'available'), driver_reports (they lose their truck_id via ON DELETE SET
 * NULL), driver_locations (lose booking_id the same way), documents not tied to
 * a booking, and every reserved table.
 *
 * A full JSON snapshot of the deleted rows is written to backups/ first.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { v2 as cloudinary } from 'cloudinary'

const dryRun = process.argv.includes('--dry-run')

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

function assetFromUrl(url) {
  const m = /res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)$/.exec(url)
  if (!m) return null
  const [, resourceType, p] = m
  return { url, resource_type: resourceType, public_id: resourceType === 'raw' ? p : p.replace(/\.[^./]+$/, '') }
}

// An idle client dropping (slow link, pooler timeout) must not crash the process.
pool.on('error', (err) => console.error('pool client error:', err.message))

const SNAPSHOT_TABLES = [
  'bookings', 'booking_destinations', 'booking_cargo_items', 'booking_trips', 'booking_trip_stops',
  'deliveries', 'driver_assignments', 'truck_assignments', 'driver_location_history',
  'booking_reference_counters', 'notifications', 'trucks', 'truck_models', 'truck_inspections',
  'truck_services', 'truck_odometer_readings', 'record_locks', 'audit_logs', 'system_logs', 'login_history',
]

// Backup first, outside the transaction and in small pages: one big
// `select *` over a slow link got its connection cut mid-download.
if (!dryRun) {
  const snapshot = {}
  for (const t of SNAPSHOT_TABLES) {
    const rows = []
    for (let offset = 0; ; offset += 200) {
      const page = (await pool.query(`select * from ${t} order by ctid limit 200 offset ${offset}`)).rows
      rows.push(...page)
      if (page.length < 200) break
    }
    snapshot[t] = rows
    console.log(`  backed up ${t.padEnd(28)} ${rows.length}`)
  }
  const dir = path.join(process.cwd(), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `purge-bookings-vehicles-notifications-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2))
  console.log(`snapshot -> ${file}\n`)
}

const db = await pool.connect()
const assets = []

try {
  await db.query('BEGIN')

  const driverIds = (await db.query(
    `select driver_id from deliveries where driver_id is not null
     union select second_driver_id from deliveries where second_driver_id is not null
     union select driver_id from driver_assignments where driver_id is not null`,
  )).rows.map((r) => r.driver_id)

  const urls = (await db.query(
    `select pickup_proof_photo_url as url from bookings
     union all select unnest(transaction_documents) from bookings
     union all select proof_photo_url from booking_destinations
     union all select pickup_proof_photo_url from booking_trips
     union all select proof_photo_url from booking_trip_stops
     union all select file_url from documents where booking_id is not null
     union all select photo_url from truck_odometer_readings
     union all select receipt_url from truck_services
     union all select image_url from truck_models`,
  )).rows.map((r) => r.url).filter(Boolean)

  const unparsed = []
  for (const url of new Set(urls)) {
    const a = assetFromUrl(url)
    if (a) assets.push(a)
    else unparsed.push(url)
  }
  console.log(`cloudinary assets: ${assets.length}${unparsed.length ? ` (+${unparsed.length} unparseable)` : ''}`)
  for (const u of unparsed) console.log(`   ?! ${u}`)

  console.log('')

  const step = async (label, sql, params) => {
    const { rowCount } = await db.query(sql, params)
    console.log(`  ${label.padEnd(44)} ${rowCount}`)
  }

  // Bookings. booking_destinations.delivery_id and bookings<-deliveries are
  // NO ACTION, so destinations, then deliveries, then bookings.
  await step('driver_location_history (booking pings)', `delete from driver_location_history where booking_id is not null`)
  await step('documents (booking-linked)',             `delete from documents where booking_id is not null`)
  await step('booking_destinations',                   `delete from booking_destinations`)
  await step('deliveries',                             `delete from deliveries`)
  await step('bookings (+trips, stops, cargo, assignments)', `delete from bookings`)
  await step('booking_reference_counters',             `delete from booking_reference_counters`)
  await step("drivers 'assigned' -> 'available'",
    `update drivers set status = 'available', updated_at = now()
      where driver_id = any($1::uuid[]) and status = 'assigned'`, [driverIds])

  // Vehicles. Cascades inspections, services, odometer readings, maintenance_records.
  await step('trucks (+inspections, services, odometer)', `delete from trucks`)
  await step('truck_models',                           `delete from truck_models`)
  await step('record_locks (booking/truck/model)',
    `delete from record_locks where resource_type in ('booking', 'truck', 'truck_model')`)

  await step('notifications',  `delete from notifications`)
  await step('audit_logs',     `delete from audit_logs`)
  await step('system_logs',    `delete from system_logs`)
  await step('login_history',  `delete from login_history`)

  const after = (await db.query(
    SNAPSHOT_TABLES.filter((t) => t !== 'record_locks')
      .map((t) => `select '${t}' t, count(*)::int n from ${t}`).join(' union all '),
  )).rows
  console.log('\nafter:')
  for (const r of after) console.log(`  ${r.t.padEnd(28)} ${r.n}`)

  if (dryRun) {
    await db.query('ROLLBACK')
    console.log('\nDRY RUN — rolled back, nothing changed. Cloudinary untouched.')
    process.exit(0)
  }
  await db.query('COMMIT')
  console.log('\nDatabase committed.')
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('\nRolled back, nothing changed:', err.message)
  process.exit(1)
} finally {
  db.release()
}

console.log('\nCloudinary:')
for (const a of assets) {
  try {
    const res = await cloudinary.uploader.destroy(a.public_id, { resource_type: a.resource_type, invalidate: true })
    console.log(`  ${String(res.result).padEnd(9)} ${a.resource_type.padEnd(5)} ${a.public_id}`)
  } catch (err) {
    console.log(`  fail      ${a.resource_type.padEnd(5)} ${a.public_id} — ${err.message}`)
  }
}

console.log('\nCloudinary folder sweep:')
for (const folder of ['booking_documents', 'delivery_proofs']) {
  for (const resourceType of ['image', 'raw', 'video']) {
    try {
      const res = await cloudinary.api.delete_resources_by_prefix(`${folder}/`, { resource_type: resourceType, invalidate: true })
      const n = Object.keys(res.deleted ?? {}).length
      if (n) console.log(`  ${folder.padEnd(18)} ${resourceType.padEnd(5)} ${n} deleted`)
    } catch (err) {
      console.log(`  fail ${folder} ${resourceType} — ${err.error?.message ?? err.message}`)
    }
  }
}

await pool.end()
process.exit(0)
