/**
 * Adds 100 more test vehicles (SEED 0101..SEED 0200) covering every vehicle
 * status and every Maintenance need, for checking the Vehicle Management tabs:
 *
 *   status:       Available, In Use, Under Maintenance, Inactive, Archived
 *   maintenance:  Passed, Blowbagets, Vehicle Maintenance, Driver Report
 *
 *   node scripts/seed-vehicles-batch2.mjs
 *
 * Needs the first seed (seed-ui-test-data.mjs) in place: it borrows that seed's
 * truck models, drivers and fleet managers. Every row it inserts is appended to
 * scripts/seed-ui-test-data.manifest.json, so the existing teardown
 * (node scripts/teardown-ui-test-data.mjs --yes) removes this batch too.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-ui-test-data.manifest.json')
if (!fs.existsSync(MANIFEST)) {
  console.error('No seed manifest: run scripts/seed-ui-test-data.mjs first.')
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
if (manifest.vehicle_batch_2_at) {
  console.error(`Batch 2 was already added at ${manifest.vehicle_batch_2_at}.`)
  process.exit(1)
}

const pad      = (n, w = 3) => String(n).padStart(w, '0')
const pick     = (arr, i) => arr[i % arr.length]
const day      = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d }
const ymd      = (d) => d.toISOString().slice(0, 10)
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000)
/** Six months ago plus `extraDays`: the service falls due `extraDays` from now. */
const sixMonthsAgoPlus = (extraDays) => { const d = new Date(); d.setMonth(d.getMonth() - 6); d.setDate(d.getDate() + extraDays); return d }

const ALL_PASS = { air: true, gas: true, oil: true, self: true, tires: true, water: true, brakes: true, engine: true, lights: true, battery: true }
const PLACES = [
  { a: 'Km 14 East Service Road, Paranaque City', lat: 14.4950, lng: 121.0410 },
  { a: 'Commonwealth Avenue, Quezon City', lat: 14.6850, lng: 121.0800 },
  { a: 'MacArthur Highway, Valenzuela City', lat: 14.7000, lng: 120.9830 },
  { a: 'Ortigas Avenue Extension, Pasig City', lat: 14.5880, lng: 121.1010 },
]

/**
 * Ten patterns, ten vehicles each.
 *   inspection: 'pass' | 'fail' | 'none'
 *   service:    'ok' | 'overdue' | 'due_soon' | 'missing'
 *   report:     null | open report's status
 */
const PATTERNS = [
  { status: 'available',         inspection: 'pass', service: 'ok',       report: null,           shows: 'Passed' },
  { status: 'in_use',            inspection: 'pass', service: 'ok',       report: null,           shows: 'Passed' },
  { status: 'under_maintenance', inspection: 'pass', service: 'ok',       report: 'reported',     shows: 'Driver Report + Vehicle Maintenance' },
  { status: 'inactive',          inspection: 'none', service: 'ok',       report: null,           shows: 'Blowbagets' },
  { status: 'archived',          inspection: 'pass', service: 'ok',       report: null,           shows: '---' },
  { status: 'under_maintenance', inspection: 'fail', service: 'ok',       report: 'reported',     shows: 'Driver Report + Blowbagets' },
  { status: 'in_use',            inspection: 'pass', service: 'ok',       report: 'acknowledged', shows: 'Driver Report' },
  { status: 'under_maintenance', inspection: 'pass', service: 'overdue',  report: null,           shows: 'Vehicle Maintenance' },
  { status: 'available',         inspection: 'none', service: 'ok',       report: null,           shows: 'Blowbagets' },
  { status: 'available',         inspection: 'pass', service: 'due_soon', report: null,           shows: 'Vehicle Maintenance' },
]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const db   = await pool.connect()
const added = {}
const track = (table, id) => { (added[table] ??= []).push(id) }

try {
  await db.query('BEGIN')
  const ins = async (table, idCol, row) => {
    const cols = Object.keys(row)
    const sql  = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, k) => `$${k + 1}`).join(', ')}) RETURNING ${idCol}`
    const id   = (await db.query(sql, Object.values(row))).rows[0][idCol]
    track(table, id)
    return id
  }

  // Borrowed from the first seed.
  const models = (await db.query(
    `select model_id from truck_models where model_id::text = any($1) and archived_at is null order by name`,
    [manifest.tables.truck_models ?? []],
  )).rows.map((r) => r.model_id)
  const fleet = (await db.query(
    `select user_id from users where user_id::text = any($1) and role = 'fleet_manager' order by email`,
    [manifest.tables.users ?? []],
  )).rows.map((r) => r.user_id)
  const drivers = (await db.query(
    `select driver_id from drivers where driver_id::text = any($1) order by license_number`,
    [manifest.tables.drivers ?? []],
  )).rows.map((r) => r.driver_id)
  const unpaired = (await db.query(
    `select d.driver_id from drivers d
      where d.driver_id::text = any($1)
        and not exists (select 1 from trucks t where t.assigned_driver_id = d.driver_id)
      order by d.license_number`,
    [manifest.tables.drivers ?? []],
  )).rows.map((r) => r.driver_id)
  if (!models.length || !fleet.length || !drivers.length) throw new Error('First seed rows are missing (models, fleet managers or drivers).')

  for (let i = 0; i < 100; i++) {
    const p     = PATTERNS[i % 10]
    // Pattern 9 alternates: service due soon, then no schedule at all.
    const service = p.service === 'due_soon' && Math.floor(i / 10) % 2 === 1 ? 'missing' : p.service
    const lastService =
      service === 'overdue'  ? day(-240) :
      service === 'due_soon' ? sixMonthsAgoPlus(3) :
      service === 'missing'  ? null : day(-30 - (i % 20))

    const truckId = await ins('trucks', 'truck_id', {
      plate_number: `SEED ${pad(101 + i, 4)}`,
      status: p.status,
      model_id: pick(models, i),
      // The 40 drivers the first seed left unpaired, on the first 40 vehicles that can have one.
      assigned_driver_id: p.status !== 'archived' && unpaired.length ? unpaired.shift() : null,
      service_interval_km:      service === 'missing' ? null : 10000,
      service_interval_months:  service === 'missing' ? null : 6,
      last_service_at:          lastService ? ymd(lastService) : null,
      last_service_odometer_km: lastService ? 40000 : null,
      odometer_km: 41000 + i * 10,
      odometer_recorded_at: hoursAgo(1 + i),
    })

    if (lastService) {
      await ins('truck_services', 'service_id', {
        truck_id: truckId, serviced_at: ymd(lastService), odometer_km: 40000,
        work_done: pick(['Change oil and filter', 'Preventive maintenance service', 'Tire rotation'], i),
        workshop: `SEED Auto Shop ${pad((i % 10) + 1)}`, recorded_by: pick(fleet, i),
      })
    }

    if (p.inspection !== 'none') {
      const passed = p.inspection === 'pass'
      await ins('truck_inspections', 'inspection_id', {
        truck_id: truckId,
        items: JSON.stringify(passed ? ALL_PASS : { ...ALL_PASS, brakes: false, tires: false }),
        passed, notes: passed ? null : 'SEED: brakes and tires failed',
        inspected_by: pick(fleet, i), inspected_at: hoursAgo(2 + i),
      })
    }

    if (p.report) {
      const place = pick(PLACES, i)
      await ins('driver_reports', 'report_id', {
        driver_id: pick(drivers, i), booking_id: null, truck_id: truckId,
        source: 'detailed', incident_type: i % 2 ? 'accident' : 'vehicle_breakdown',
        description: `SEED vehicle report ${pad(i + 1)}: ${pick(['engine overheating on the expressway', 'flat tire at the loading bay', 'minor collision while reversing'], i)}`,
        latitude: place.lat, longitude: place.lng, address: place.a, trip_can_continue: i % 3 !== 0,
        status: p.report,
        acknowledged_by: p.report === 'acknowledged' ? pick(fleet, i) : null,
        acknowledged_at: p.report === 'acknowledged' ? hoursAgo(i) : null,
        created_at: hoursAgo(3 + i),
      })
    }
  }

  await db.query('COMMIT')

  // Only after the commit, so the manifest never lists rows that were rolled back.
  for (const [table, ids] of Object.entries(added)) (manifest.tables[table] ??= []).push(...ids)
  manifest.vehicle_batch_2_at = new Date().toISOString()
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))

  console.log('Added (also listed in the seed manifest):')
  for (const [t, ids] of Object.entries(added)) console.log(`  ${t.padEnd(20)} ${ids.length}`)
  console.log('\nPer pattern (10 vehicles each):')
  for (const [k, p] of PATTERNS.entries()) console.log(`  ${k}: ${p.status.padEnd(18)} -> ${p.shows}`)
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('Failed; nothing was inserted.')
  console.error(err)
  process.exitCode = 1
} finally {
  db.release()
  await pool.end()
}
