/**
 * A small set of test vehicles (SEED B01..) where every Vehicle Management badge
 * shows at least once, one vehicle per badge:
 *
 *   status:       Available, In Use, Under Maintenance, Inactive, Archived
 *   maintenance:  Passed, Blowbagets Re-check (never inspected / failed / re-check
 *                 after a delivery), Vehicle Maintenance (out of service, service
 *                 overdue / due soon / no schedule, return odometer owed),
 *                 View Driver Report (reported / acknowledged)
 *
 *   node scripts/seed-maintenance-badges.mjs
 *
 * Stands on its own: it makes one seed client (for the delivered bookings the
 * re-check and odometer rows need) and one seed driver (for the reports), and
 * borrows an existing vehicle model. Every row goes into
 * scripts/seed-ui-test-data.manifest.json (created if missing), so
 * node scripts/teardown-ui-test-data.mjs --yes removes it all.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-ui-test-data.manifest.json')
const manifest = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  : { created_at: new Date().toISOString(), auth_user_ids: [], tables: {} }
manifest.auth_user_ids ??= []
manifest.tables ??= {}
if (manifest.maintenance_badges_at) {
  console.error(`The badge vehicles were already added at ${manifest.maintenance_badges_at}.`)
  process.exit(1)
}
const saveManifest = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))

const pad      = (n, w = 2) => String(n).padStart(w, '0')
const day      = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d }
const ymd      = (d) => d.toISOString().slice(0, 10)
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000)
/** Six months ago plus `extraDays`: the service falls due `extraDays` from now. */
const sixMonthsAgoPlus = (extraDays) => { const d = new Date(); d.setMonth(d.getMonth() - 6); d.setDate(d.getDate() + extraDays); return d }

const ALL_PASS = { air: true, gas: true, oil: true, self: true, tires: true, water: true, brakes: true, engine: true, lights: true, battery: true }
const PLACE    = { a: 'Km 14 East Service Road, Paranaque City', lat: 14.4950, lng: 121.0410 }

/**
 * One vehicle per badge.
 *   inspection: 'pass' | 'fail' | 'none' | 'pass_before_return' (spent by a later delivery)
 *   service:    'ok' | 'overdue' | 'due_soon' | 'missing'
 *   returned:   back from a delivery 24 hours ago
 *   odometer:   'after_return' (default) | 'before_return' (the after-delivery reading is owed)
 *   report:     null | open report's status
 */
const VEHICLES = [
  { shows: 'Available · Passed',                          status: 'available',         inspection: 'pass' },
  { shows: 'In Use · Passed',                             status: 'in_use',            inspection: 'pass' },
  { shows: 'Inactive',                                    status: 'inactive',          inspection: 'pass' },
  { shows: 'Archived',                                    status: 'archived',          inspection: 'pass' },
  { shows: 'Blowbagets Re-check: never inspected',        status: 'available',         inspection: 'none' },
  { shows: 'Blowbagets Re-check: failed (Under Maintenance)', status: 'under_maintenance', inspection: 'fail' },
  { shows: 'Blowbagets Re-check: back from a delivery',   status: 'recheck_due',       inspection: 'pass_before_return', returned: true },
  { shows: 'Vehicle Maintenance: odometer owed',          status: 'available',         inspection: 'pass', returned: true, odometer: 'before_return' },
  { shows: 'Vehicle Maintenance: out of service',         status: 'under_maintenance', inspection: 'pass' },
  { shows: 'Vehicle Maintenance: service overdue',        status: 'available',         inspection: 'pass', service: 'overdue' },
  { shows: 'Vehicle Maintenance: service due soon',       status: 'available',         inspection: 'pass', service: 'due_soon' },
  { shows: 'Vehicle Maintenance: no service schedule',    status: 'available',         inspection: 'pass', service: 'missing' },
  { shows: 'View Driver Report: reported',                status: 'available',         inspection: 'pass', report: 'reported' },
  { shows: 'View Driver Report: acknowledged (In Use)',   status: 'in_use',            inspection: 'pass', report: 'acknowledged' },
]

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** Saved to the manifest straight away, so a failed run's auth users still get torn down. */
async function createAuthUser(email) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: crypto.randomBytes(24).toString('base64url'),
    email_confirm: true,
    user_metadata: { seed: 'maintenance-badges' },
  })
  if (error) throw new Error(`auth user ${email}: ${error.message}`)
  manifest.auth_user_ids.push(data.user.id)
  saveManifest()
  return data.user.id
}

const tag         = Date.now().toString(36)
const clientEmail = `seed.badges.client.${tag}@example.com`
const driverEmail = `seed.badges.driver.${tag}@example.com`
const clientAuth  = await createAuthUser(clientEmail)
const driverAuth  = await createAuthUser(driverEmail)

const pool  = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const db    = await pool.connect()
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

  const model = (await db.query(`select model_id from truck_models where archived_at is null order by name limit 1`)).rows[0]?.model_id
  if (!model) throw new Error('No live vehicle model to borrow.')

  await ins('users', 'user_id', { user_id: clientAuth, email: clientEmail, role: 'client', status: 'active', first_name: 'SEED', last_name: 'Badge Client' })
  await ins('users', 'user_id', { user_id: driverAuth, email: driverEmail, role: 'driver', status: 'active', first_name: 'SEED', last_name: 'Badge Driver' })
  const clientId = await ins('clients', 'client_id', {
    user_id: clientAuth, company_name: 'SEED Badge Company', registered_name: 'SEED Badge Company Inc.', billing_address: PLACE.a,
  })
  const expiry   = ymd(day(400))
  const driverId = await ins('drivers', 'driver_id', {
    user_id: driverAuth, license_number: `SEED-BADGE-${tag}`, license_expiry: expiry,
    license_reminder_notified_for: expiry, license_reminder_emailed_for: expiry,
    status: 'available', is_external: false,
  })

  const returnedAt = hoursAgo(24)
  for (const [i, v] of VEHICLES.entries()) {
    const service = v.service ?? 'ok'
    const lastService =
      service === 'overdue'  ? day(-240) :
      service === 'due_soon' ? sixMonthsAgoPlus(3) :
      service === 'missing'  ? null : day(-30)

    const truckId = await ins('trucks', 'truck_id', {
      plate_number: `SEED B${pad(i + 1)}`,
      status: v.status,
      model_id: model,
      service_interval_km:      service === 'missing' ? null : 10000,
      service_interval_months:  service === 'missing' ? null : 6,
      last_service_at:          lastService ? ymd(lastService) : null,
      last_service_odometer_km: lastService ? 40000 : null,
      odometer_km: 41000 + i * 10,
      odometer_recorded_at: v.odometer === 'before_return' ? hoursAgo(48) : hoursAgo(12),
    })

    if (lastService) {
      await ins('truck_services', 'service_id', {
        truck_id: truckId, serviced_at: ymd(lastService), odometer_km: 40000,
        work_done: 'Change oil and filter', workshop: 'SEED Auto Shop',
      })
    }

    if (v.inspection !== 'none') {
      const passed = v.inspection !== 'fail'
      await ins('truck_inspections', 'inspection_id', {
        truck_id: truckId,
        items: JSON.stringify(passed ? ALL_PASS : { ...ALL_PASS, brakes: false, tires: false }),
        passed, notes: passed ? null : 'SEED: brakes and tires failed',
        // A pass from before the delivery is spent; every other one is fresh.
        inspected_at: v.inspection === 'pass_before_return' ? hoursAgo(48) : hoursAgo(6),
      })
    }

    // The delivery the vehicle came back from: what makes a re-check or a return odometer due.
    if (v.returned) {
      const bookingId = await ins('bookings', 'booking_id', {
        client_id: clientId, origin: PLACE.a, origin_latitude: PLACE.lat, origin_longitude: PLACE.lng,
        schedule_date: ymd(day(-2)), call_time: '08:00', status: 'completed',
        gm_status: 'approved', ops_status: 'assigned',
        delivered_at: hoursAgo(26), fleet_return_at: returnedAt, created_at: hoursAgo(72),
      })
      await ins('deliveries', 'delivery_id', {
        booking_id: bookingId, truck_id: truckId, status: 'delivered',
        pickup_time: hoursAgo(30), delivery_time: hoursAgo(26),
      })
    }

    if (v.report) {
      await ins('driver_reports', 'report_id', {
        driver_id: driverId, booking_id: null, truck_id: truckId,
        source: 'detailed', incident_type: v.report === 'reported' ? 'vehicle_breakdown' : 'accident',
        description: `SEED vehicle report: ${v.report === 'reported' ? 'engine overheating on the expressway' : 'minor collision while reversing'}`,
        latitude: PLACE.lat, longitude: PLACE.lng, address: PLACE.a, trip_can_continue: v.report !== 'reported',
        status: v.report,
        acknowledged_at: v.report === 'acknowledged' ? hoursAgo(2) : null,
        created_at: hoursAgo(3 + i),
      })
    }
  }

  await db.query('COMMIT')

  // Only after the commit, so the manifest never lists rows that were rolled back.
  for (const [table, ids] of Object.entries(added)) (manifest.tables[table] ??= []).push(...ids)
  manifest.maintenance_badges_at = new Date().toISOString()
  saveManifest()

  console.log('Added (also listed in the seed manifest):')
  for (const [t, ids] of Object.entries(added)) console.log(`  ${t.padEnd(20)} ${ids.length}`)
  console.log('\nVehicles:')
  for (const [i, v] of VEHICLES.entries()) console.log(`  SEED B${pad(i + 1)}  ${v.shows}`)
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('Failed; no table rows were inserted (the two auth users are in the manifest for the teardown).')
  console.error(err)
  process.exitCode = 1
} finally {
  db.release()
  await pool.end()
}
