/**
 * Fills the screens with test rows so the UI can be checked with full tables.
 * 100 of each:
 *
 *   people     clients, company drivers, vendor drivers, Company Administrators,
 *              General Managers, Operations Managers, Fleet Managers
 *   fleet      vehicle models (spread over every active vehicle type) and
 *              vehicles (ten status/maintenance patterns, as Vehicle Management
 *              shows them), with their inspections, odometer readings, services
 *   work       bookings (every status, with stops, cargo, crew, trips; some with a
 *              second driver or a helper), documents, driver reports, support
 *              tickets, password reset requests, audit logs, system logs
 *
 *   node scripts/seed-ui-test-data.mjs            # insert
 *   node scripts/teardown-ui-test-data.mjs        # remove exactly what this inserted
 *
 * Everything inserted is recorded in scripts/seed-ui-test-data.manifest.json
 * (table -> ids). The teardown deletes by those ids only, never by pattern.
 * Recognisable on sight too: emails end @seed.test, names/plates/licences
 * start SEED, booking references are SEED-0001..
 *
 * Kept away from real people and the schedulers:
 *  - seeded users get @seed.test addresses, no push subscription, no passkey,
 *    and a random password nobody knows;
 *  - licences expire 1-3 years out and their reminder stamps are pre-set;
 *  - assigned bookings carry both fleet re-check stamps;
 *  - delivered bookings carry a reported client problem, which takes them out
 *    of the 3-day auto-complete queue;
 *  - the booking reference trigger's counter is rewound after the insert, so
 *    real booking numbers continue as if nothing happened.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const N = 100
const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-ui-test-data.manifest.json')

if (fs.existsSync(MANIFEST)) {
  console.error(`${MANIFEST} already exists. Run the teardown first (or delete the file if it is stale).`)
  process.exit(1)
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const manifest = { created_at: new Date().toISOString(), auth_user_ids: [], tables: {} }
const saveManifest = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))
const track = (table, id) => { (manifest.tables[table] ??= []).push(id) }

// ---------------------------------------------------------------- helpers
const pad   = (n, w = 3) => String(n).padStart(w, '0')
const pick  = (arr, i) => arr[i % arr.length]
const day   = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d }
const ymd   = (d) => d.toISOString().slice(0, 10)
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000)
/** Six months ago plus `extraDays`: the service falls due `extraDays` from now. */
const sixMonthsAgoPlus = (extraDays) => { const d = new Date(); d.setMonth(d.getMonth() - 6); d.setDate(d.getDate() + extraDays); return d }

const FIRST = ['Juan', 'Maria', 'Jose', 'Ana', 'Mark', 'Grace', 'Paolo', 'Liza', 'Carlo', 'Joy', 'Rafael', 'Bea', 'Miguel', 'Kris', 'Andre', 'Nina', 'Ramon', 'Tess', 'Luis', 'Camille']
const LAST  = ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Garcia', 'Mendoza', 'Torres', 'Flores', 'Villanueva', 'Ramos', 'Castillo', 'Aquino', 'Navarro', 'Domingo', 'Salazar', 'Rivera', 'Del Rosario', 'Pascual', 'Lim', 'Tan']
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
]
const COMMODITIES = ['Beverages', 'Snacks', 'Personal Care', 'Household Cleaning', 'Canned Goods', 'Dairy']
const PRODUCTS    = ['Bottled Water 500ml', 'Potato Chips 60g', 'Shampoo Sachet', 'Dishwashing Liquid 250ml', 'Corned Beef 150g', 'Evaporated Milk 370ml']
const ALL_PASS    = { air: true, gas: true, oil: true, self: true, tires: true, water: true, brakes: true, engine: true, lights: true, battery: true }
const USER_STATUS = ['active', 'active', 'active', 'active', 'inactive', 'deactivated', 'permanently_locked', 'archived', 'active', 'active']

/**
 * Vehicle Management's ten cases, ten vehicles each.
 *   inspection: 'pass' | 'fail' | 'none'
 *   service:    'ok' | 'overdue' | 'due_soon' (alternating with no schedule at all)
 *   report:     null | open report's status
 */
const PATTERNS = [
  { status: 'available',         inspection: 'pass', service: 'ok',       report: null           },
  { status: 'in_use',            inspection: 'pass', service: 'ok',       report: null           },
  { status: 'under_maintenance', inspection: 'pass', service: 'ok',       report: 'reported'     },
  { status: 'inactive',          inspection: 'none', service: 'ok',       report: null           },
  { status: 'archived',          inspection: 'pass', service: 'ok',       report: null           },
  { status: 'under_maintenance', inspection: 'fail', service: 'ok',       report: 'reported'     },
  { status: 'in_use',            inspection: 'pass', service: 'ok',       report: 'acknowledged' },
  { status: 'under_maintenance', inspection: 'pass', service: 'overdue',  report: null           },
  { status: 'available',         inspection: 'none', service: 'ok',       report: null           },
  { status: 'available',         inspection: 'pass', service: 'due_soon', report: null           },
]

// --------------------------------------------------- auth + profile users
async function createAuthUser(email) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: crypto.randomBytes(24).toString('base64url'),
    email_confirm: true,
    user_metadata: { seed: 'ui-test-data' },
  })
  if (error) throw new Error(`auth user ${email}: ${error.message}`)
  manifest.auth_user_ids.push(data.user.id)
  return data.user.id
}

/** 100 accounts of one kind, created ten at a time. */
async function createGroup(kind, role, emailPrefix) {
  const out = []
  for (let start = 1; start <= N; start += 10) {
    const batch = await Promise.all(Array.from({ length: 10 }, (_, k) => start + k).map(async (i) => {
      const email = `seed.${emailPrefix}${pad(i)}@seed.test`
      return { i, kind, role, email, id: await createAuthUser(email) }
    }))
    out.push(...batch)
    saveManifest()
  }
  console.log(`  ${kind.padEnd(18)} ${out.length}`)
  return out
}

console.log('Creating auth users (100 of each kind)…')
const people = {
  client:   await createGroup('client',             'client',             'client'),
  driver:   await createGroup('company driver',     'driver',             'driver'),
  vendor:   await createGroup('vendor driver',      'driver',             'vendordriver'),
  admin:    await createGroup('company admin',      'admin',              'admin'),
  gm:       await createGroup('general manager',    'general_manager',    'generalmanager'),
  ops:      await createGroup('operations manager', 'operations_manager', 'operationsmanager'),
  fleet:    await createGroup('fleet manager',      'fleet_manager',      'fleetmanager'),
}
// The first ten of each staff role stay active and act on the seeded records.
const actors = (list) => list.slice(0, 10)
const gms    = actors(people.gm)
const opss   = actors(people.ops)
const fleet  = actors(people.fleet)
const admins = actors(people.admin)

// ------------------------------------------------------------ database
const db = await pool.connect()
try {
  await db.query('BEGIN')

  const ins = async (table, idCol, row) => {
    const cols = Object.keys(row)
    const vals = Object.values(row)
    const sql  = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, k) => `$${k + 1}`).join(', ')}) RETURNING ${idCol}`
    const id   = (await db.query(sql, vals)).rows[0][idCol]
    track(table, id)
    return id
  }

  // Phones: 0999 + 7 digits, skipping any already taken.
  const taken = new Set((await db.query(`select phone from users where phone like '0999%'`)).rows.map((r) => r.phone))
  let phoneSeq = 1000000
  const nextPhone = () => { let p; do { p = `0999${phoneSeq++}` } while (taken.has(p)); return p }

  // users
  const all = Object.values(people).flat()
  for (const [k, p] of all.entries()) {
    const staff  = !['client', 'driver'].includes(p.role)
    // Only one non-archived General Manager may exist (users_one_general_manager),
    // and that is the real one: every seeded GM is archived.
    const status = p.role === 'general_manager' ? 'archived'
      : staff && p.i <= 10 ? 'active' : pick(USER_STATUS, p.i - 1)
    await ins('users', 'user_id', {
      user_id: p.id, email: p.email, phone: nextPhone(), role: p.role, status,
      first_name: pick(FIRST, k), last_name: pick(LAST, k + 3 + Math.floor(k / 20)), middle_name: null,
      created_at: hoursAgo(24 * 60 - (k % 200) * 6), last_login_at: k % 3 ? hoursAgo(k % 300) : null,
    })
  }

  // clients (company per client user)
  const clientIds = []
  for (const p of people.client) {
    clientIds.push(await ins('clients', 'client_id', {
      user_id: p.id, company_name: `SEED Company ${pad(p.i)}`, registered_name: `SEED Company ${pad(p.i)} Inc.`,
      billing_address: pick(PLACES, p.i).a, landline: `(02) 8${pad(p.i, 3)}-${pad(p.i * 7 % 10000, 4)}`,
    }))
  }

  // drivers: 100 company crew, 100 vendor-supplied
  const DRIVER_STATUS = ['available', 'available', 'assigned', 'unavailable', 'on_leave']
  const driverIds = []
  for (const p of people.driver) {
    const expiry = ymd(day(365 + p.i * 7))
    driverIds.push(await ins('drivers', 'driver_id', {
      user_id: p.id, license_number: `SEED-LIC-${pad(p.i, 4)}`, license_expiry: expiry,
      license_reminder_notified_for: expiry, license_reminder_emailed_for: expiry,
      status: pick(DRIVER_STATUS, p.i), is_external: false,
      emergency_contact_name: `${pick(FIRST, p.i + 5)} ${pick(LAST, p.i)}`, emergency_contact_phone: `0917${pad(p.i, 7)}`,
    }))
  }
  for (const p of people.vendor) {
    const expiry  = ymd(day(400 + p.i * 5))
    const revoked = p.i % 10 === 0
    await ins('drivers', 'driver_id', {
      user_id: p.id, license_number: `SEED-VLIC-${pad(p.i, 4)}`, license_expiry: expiry,
      license_reminder_notified_for: expiry, license_reminder_emailed_for: expiry,
      status: pick(DRIVER_STATUS, p.i), is_external: true,
      vendor_name: `SEED Vendor ${pad(((p.i - 1) % 20) + 1)}`, vendor_contact: `0918${pad(p.i, 7)}`,
      emergency_contact_name: `${pick(FIRST, p.i + 9)} ${pick(LAST, p.i + 2)}`, emergency_contact_phone: `0919${pad(p.i, 7)}`,
      access_revoked_at: revoked ? hoursAgo(p.i) : null, access_revoked_reason: revoked ? 'SEED: booking completed' : null,
    })
  }

  // vehicle models, spread over every active vehicle type
  const types = (await db.query(`select name from vehicle_types where is_active order by name`)).rows.map((r) => r.name)
  if (!types.length) types.push('Closed Van', 'Wing Van')
  const modelImage = (await db.query(`select image_url from truck_models where image_url is not null limit 1`)).rows[0]?.image_url
  const modelIds = []
  for (let i = 1; i <= N; i++) {
    const wheels = pick([4, 6, 6, 10], i)
    const type   = pick(types, i)
    modelIds.push(await ins('truck_models', 'model_id', {
      name: `SEED ${wheels}-Wheeler ${type} ${pad(i)}`, vehicle_type: type,
      suitable_for: 'FMCG', stackable_friendly: i % 2 === 0,
      max_weight_kg: wheels * 1000, max_volume_cbm: wheels * 4, max_length_cm: 400 + wheels * 50,
      length_mm: 4000 + wheels * 500, width_mm: 2000, height_mm: 2100,
      image_url: modelImage ?? 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
      archived_at: i > 95 ? new Date() : null,
    }))
  }
  const liveModels = modelIds.slice(0, 95)

  // vehicles: the ten Vehicle Management patterns; company driver i drives vehicle i
  const trucks = []
  for (let i = 0; i < N; i++) {
    const p = PATTERNS[i % 10]
    const service = p.service === 'due_soon' && Math.floor(i / 10) % 2 === 1 ? 'missing' : p.service
    const lastService =
      service === 'overdue'  ? day(-240) :
      service === 'due_soon' ? sixMonthsAgoPlus(3) :
      service === 'missing'  ? null : day(-30 - (i % 20))
    const driverIdx = p.status === 'archived' ? null : i
    // Registration 1-2 years out, reminder stamps pre-set so the scheduler skips it.
    const registration = ymd(day(365 + i * 4))

    const truckId = await ins('trucks', 'truck_id', {
      plate_number: `SEED ${pad(i + 1, 4)}`, status: p.status, model_id: pick(liveModels, i),
      registration_expiry: registration,
      registration_reminder_notified_for: registration, registration_reminder_emailed_for: registration,
      assigned_driver_id: driverIdx === null ? null : driverIds[driverIdx],
      service_interval_km:      service === 'missing' ? null : 10000,
      service_interval_months:  service === 'missing' ? null : 6,
      last_service_at:          lastService ? ymd(lastService) : null,
      last_service_odometer_km: lastService ? 40000 : null,
      odometer_km: 41000 + i * 150, odometer_recorded_at: hoursAgo(1 + i),
    })
    trucks.push({ id: truckId, status: p.status, driverIdx })

    let inspId = null
    if (p.inspection !== 'none') {
      const passed = p.inspection === 'pass'
      inspId = await ins('truck_inspections', 'inspection_id', {
        truck_id: truckId, items: JSON.stringify(passed ? ALL_PASS : { ...ALL_PASS, brakes: false, tires: false }),
        passed, notes: passed ? null : 'SEED: brakes and tires failed', inspected_by: pick(fleet, i).id, inspected_at: hoursAgo(2 + i),
      })
    }
    await ins('truck_odometer_readings', 'reading_id', {
      truck_id: truckId, reading_km: 41000 + i * 150, kind: pick(['initial', 'pre_trip', 'post_trip', 'manual'], i),
      inspection_id: inspId, recorded_by: pick(fleet, i).id, recorded_at: hoursAgo(1 + i),
    })
    if (lastService) {
      await ins('truck_services', 'service_id', {
        truck_id: truckId, serviced_at: ymd(lastService), odometer_km: 40000,
        work_done: pick(['Change oil and filter', 'Brake pad replacement', 'Tire rotation', 'Preventive maintenance service'], i),
        workshop: `SEED Auto Shop ${pad((i % 10) + 1)}`, recorded_by: pick(fleet, i).id,
      })
    }
    if (p.report) {
      const place = pick(PLACES, i)
      await ins('driver_reports', 'report_id', {
        driver_id: driverIds[i], booking_id: null, truck_id: truckId,
        source: 'detailed', incident_type: i % 2 ? 'accident' : 'vehicle_breakdown',
        description: `SEED vehicle report ${pad(i + 1)}: ${pick(['engine overheating on the expressway', 'flat tire at the loading bay', 'minor collision while reversing'], i)}`,
        latitude: place.lat, longitude: place.lng, address: place.a, trip_can_continue: i % 3 !== 0,
        status: p.report,
        acknowledged_by: p.report === 'acknowledged' ? pick(fleet, i).id : null,
        acknowledged_at: p.report === 'acknowledged' ? hoursAgo(i) : null,
        created_at: hoursAgo(3 + i),
      })
    }
  }
  // Crew for bookings: vehicles that have a driver and are not archived.
  const crewable = trucks.filter((t) => t.driverIdx !== null)

  // bookings
  const counterBefore = (await db.query(
    `select last_value from booking_reference_counters where period = to_char(now() at time zone 'Asia/Manila', 'YYYYMM')`,
  )).rows[0]?.last_value ?? null

  const PLAN = [
    ...Array(25).fill('pending'), ...Array(15).fill('approved'), ...Array(15).fill('assigned'),
    ...Array(15).fill('in_transit'), ...Array(5).fill('delivered'), ...Array(15).fill('completed'), ...Array(10).fill('cancelled'),
  ]
  const bookingIds = []
  for (let i = 0; i < N; i++) {
    const status   = PLAN[i]
    const client   = people.client[i % N]
    const origin   = pick(PLACES, i)
    const past     = ['in_transit', 'delivered', 'completed'].includes(status)
    const schedule = ymd(day(past ? -(i % 20) : (i % 25) + 1))
    const gmDone   = !['pending'].includes(status) && !(status === 'cancelled' && i % 2)
    const opsDone  = ['assigned', 'in_transit', 'delivered', 'completed'].includes(status)
    const gm  = pick(gms, i)
    const ops = pick(opss, i)
    const createdAt = hoursAgo((N - i) * 5 + 2)

    const bookingId = await ins('bookings', 'booking_id', {
      client_id: clientIds[i % N], origin: origin.a, origin_latitude: origin.lat, origin_longitude: origin.lng,
      truck_type_needed: opsDone ? pick(types, i) : null, schedule_date: schedule, call_time: pick(['06:00', '07:30', '08:00', '09:15', '13:00'], i),
      status, created_at: createdAt,
      gm_status: status === 'cancelled' ? (gmDone ? 'rejected' : 'pending') : gmDone ? 'approved' : 'pending',
      ops_status: opsDone ? 'assigned' : 'pending',
      gm_reviewed_by: gmDone ? gm.id : null, gm_reviewed_at: gmDone ? new Date(createdAt.getTime() + 3600_000) : null, gm_reviewed_role: gmDone ? 'general_manager' : null,
      ops_assigned_by: opsDone ? ops.id : null, ops_assigned_at: opsDone ? new Date(createdAt.getTime() + 7200_000) : null, ops_assigned_role: opsDone ? 'operations_manager' : null,
      rejection_reason: status === 'cancelled' && gmDone ? 'SEED: route not serviceable on the requested date' : null,
      cancelled_by: status === 'cancelled' ? (gmDone ? gm.id : client.id) : null, cancelled_at: status === 'cancelled' ? new Date(createdAt.getTime() + 5400_000) : null,
      required_weight_kg: 500 + i * 20, required_volume_cbm: 2 + (i % 10),
      // keep the schedulers off seeded rows
      fleet_recheck_day_before_at: status === 'assigned' ? new Date() : null,
      fleet_recheck_day_of_at:     status === 'assigned' ? new Date() : null,
      delivered_at: ['delivered', 'completed'].includes(status) ? hoursAgo(i) : null,
      client_issue_note: status === 'delivered' ? 'SEED: two cases arrived dented' : null,
      client_issue_reported_at: status === 'delivered' ? hoursAgo(i - 1 > 0 ? i - 1 : 0) : null,
      client_issue_reported_by: status === 'delivered' ? client.id : null,
      completion_confirmed_by: status === 'completed' ? client.id : null, completion_confirmed_role: status === 'completed' ? 'client' : null,
      completion_confirmed_at: status === 'completed' ? hoursAgo(i) : null,
      completion_reminder_sent_at: ['delivered', 'completed'].includes(status) ? new Date() : null,
      paused_at: status === 'in_transit' && i % 5 === 0 ? hoursAgo(1) : null,
      pause_reason: status === 'in_transit' && i % 5 === 0 ? 'traffic' : null,
    })
    bookingIds.push(bookingId)
    // The trigger stamped a real BK- number; give it a SEED one instead.
    await db.query(`update bookings set reference_number = $1 where booking_id = $2`, [`SEED-${pad(i + 1, 4)}`, bookingId])

    // stops + cargo
    const stops = (i % 3) + 1
    const destIds = []
    const itemIds = []
    for (let s = 1; s <= stops; s++) {
      const place = pick(PLACES, i + s * 5)
      const delivered = status === 'completed' || status === 'delivered' || (status === 'in_transit' && s === 1 && stops > 1)
      const destId = await ins('booking_destinations', 'destination_id', {
        booking_id: bookingId, address: place.a, latitude: place.lat, longitude: place.lng, sequence_order: s,
        status: delivered ? 'delivered' : 'pending', delivered_at: delivered ? hoursAgo(i + s) : null,
      })
      destIds.push(destId)
      itemIds.push(await ins('booking_cargo_items', 'item_id', {
        booking_id: bookingId, destination_id: destId, commodity_text: pick(COMMODITIES, i + s), product_text: pick(PRODUCTS, i + s),
        quantity: 10 + s * 5, weight_kg: 120 + s * 30, volume_cbm: 0.8 + s * 0.2, length_cm: 40, width_cm: 30, height_cm: 25,
      }))
    }

    if (opsDone) {
      const crew   = pick(crewable, i)
      const main   = driverIds[crew.driverIdx]
      // Every third crewed booking has a second driver, the next a helper.
      const second = i % 3 === 0 ? driverIds[pick(crewable, i + 7).driverIdx] : null
      const deliveryId = await ins('deliveries', 'delivery_id', {
        booking_id: bookingId, driver_id: main, truck_id: crew.id,
        second_driver_id: second && second !== main ? second : null,
        helper_name: i % 3 === 1 ? `${pick(FIRST, i + 11)} ${pick(LAST, i + 7)}` : null,
        status: status === 'assigned' ? 'pending' : status === 'in_transit' ? 'in_transit' : 'delivered',
        pickup_time: status === 'assigned' ? null : hoursAgo(i + 4), delivery_time: ['delivered', 'completed'].includes(status) ? hoursAgo(i) : null,
      })
      for (const destId of destIds) await db.query(`update booking_destinations set delivery_id = $1 where destination_id = $2`, [deliveryId, destId])
      await ins('driver_assignments', 'assignment_id', { booking_id: bookingId, driver_id: main, assigned_by: ops.id, crew_role: 'lead' })
      if (second && second !== main) {
        await ins('driver_assignments', 'assignment_id', { booking_id: bookingId, driver_id: second, assigned_by: ops.id, crew_role: 'second' })
      }

      const tripStatus = status === 'assigned' ? 'pending' : status === 'in_transit' ? 'in_transit' : 'completed'
      const tripId = await ins('booking_trips', 'trip_id', {
        booking_id: bookingId, trip_number: 1, status: tripStatus,
        planned_departure_at: new Date(`${schedule}T08:00:00+08:00`), planned_arrival_at: new Date(`${schedule}T11:00:00+08:00`),
        pickup_proof_at: tripStatus === 'pending' ? null : hoursAgo(i + 4),
      })
      for (const [s, destId] of destIds.entries()) {
        const stopDone = tripStatus === 'completed' || (tripStatus === 'in_transit' && s === 0 && destIds.length > 1)
        const stopId = await ins('booking_trip_stops', 'trip_stop_id', {
          trip_id: tripId, destination_id: destId, sequence_order: s + 1,
          status: stopDone ? 'delivered' : 'pending', delivered_at: stopDone ? hoursAgo(i + s) : null,
        })
        await ins('booking_trip_cargo', 'trip_cargo_id', {
          booking_id: bookingId, trip_id: tripId, trip_stop_id: stopId, item_id: itemIds[s],
          planned_qty: 10 + (s + 1) * 5, loaded_qty: tripStatus === 'pending' ? null : 10 + (s + 1) * 5,
        })
      }
    }
  }

  // Rewind the reference counter by the 100 numbers the trigger handed out.
  // The counter row stayed locked by this transaction, so nothing else drew a number meanwhile.
  if (counterBefore === null) {
    await db.query(`delete from booking_reference_counters where period = to_char(now() at time zone 'Asia/Manila', 'YYYYMM')`)
  } else {
    await db.query(`update booking_reference_counters set last_value = $1 where period = to_char(now() at time zone 'Asia/Manila', 'YYYYMM')`, [counterBefore])
  }

  // documents
  const DOC_TYPES = ['delivery_receipt', 'trip_ticket', 'proof_of_delivery', 'purchase_order', 'other']
  for (let i = 0; i < N; i++) {
    const status = pick(['pending', 'approved', 'approved', 'rejected', 'archived'], i)
    await ins('documents', 'document_id', {
      booking_id: bookingIds[i], document_type: pick(DOC_TYPES, i), file_url: modelImage ?? 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
      original_name: `SEED-document-${pad(i + 1)}.png`, file_format: 'png', bytes: 120000 + i * 100,
      uploaded_by: pick(opss, i).id, status, uploaded_at: hoursAgo(i * 2),
      reviewed_by: status === 'pending' ? null : pick(admins, i).id, reviewed_at: status === 'pending' ? null : hoursAgo(i * 2 - 1),
      rejection_reason: status === 'rejected' ? 'SEED: blurry scan, please re-upload' : null,
      archived_at: status === 'archived' ? hoursAgo(i) : null, archived_by: status === 'archived' ? pick(admins, i).id : null,
      notes: 'SEED test document',
    })
  }

  // driver reports (on top of the vehicle-pattern ones above)
  const INCIDENTS = ['accident', 'vehicle_breakdown', 'health_emergency', 'security_threat']
  for (let i = 0; i < N; i++) {
    const status = pick(['reported', 'acknowledged', 'resolved'], i)
    const place  = pick(PLACES, i)
    const crew   = pick(crewable, i)
    await ins('driver_reports', 'report_id', {
      driver_id: driverIds[crew.driverIdx], booking_id: i < 30 ? bookingIds[55 + (i % 30)] ?? null : null, truck_id: crew.id,
      source: i % 4 === 0 ? 'quick' : 'detailed', incident_type: pick(INCIDENTS, i),
      description: `SEED report ${pad(i + 1)}: ${pick(['flat tire on the expressway', 'minor collision at the loading bay', 'driver felt dizzy, resting', 'suspicious vehicle following the truck'], i)}`,
      latitude: place.lat, longitude: place.lng, address: place.a, trip_can_continue: i % 3 !== 0,
      status, acknowledged_by: status === 'reported' ? null : pick(fleet, i).id, acknowledged_at: status === 'reported' ? null : hoursAgo(i),
      resolved_by: status === 'resolved' ? pick(fleet, i).id : null, resolved_at: status === 'resolved' ? hoursAgo(i - 1 > 0 ? i - 1 : 0) : null,
      resolution_note: status === 'resolved' ? 'SEED: handled, trip resumed' : null, created_at: hoursAgo(i * 4 + 1),
    })
  }

  // support tickets
  const CATS = ['booking', 'delivery', 'tracking', 'documents', 'account', 'other']
  for (let i = 0; i < N; i++) {
    const resolved = i % 3 === 0
    await ins('support_tickets', 'ticket_id', {
      client_id: clientIds[i], opened_by: people.client[i].id, booking_id: bookingIds[i],
      category: pick(CATS, i), subject: `SEED ticket ${pad(i + 1)}: ${pick(['Where is my delivery?', 'Need a copy of the delivery receipt', 'Cannot update my company name', 'Wrong drop-off address'], i)}`,
      message: 'SEED: this is a test support ticket created to fill the table for UI testing.',
      status: resolved ? 'resolved' : 'open', resolved_at: resolved ? hoursAgo(i) : null, resolved_by: resolved ? pick(admins, i).id : null,
      resolution_note: resolved ? 'SEED: replied by email' : null, created_at: hoursAgo(i * 3 + 2),
    })
  }

  // password reset requests: 50 for the Company Administrator's queue (clients and
  // drivers), 50 for the IT Administrator's (staff)
  const resetUsers = [
    ...people.client.slice(0, 25), ...people.driver.slice(0, 25),
    ...people.admin.slice(10, 23), ...people.gm.slice(10, 23), ...people.ops.slice(10, 22), ...people.fleet.slice(10, 22),
  ]
  for (const [i, p] of resetUsers.entries()) {
    const status = pick(['pending', 'pending', 'completed', 'cancelled', 'expired'], i)
    await ins('password_reset_requests', 'request_id', {
      user_id: p.id, email: p.email, requested_role: p.role,
      handler_group: p.role === 'client' || p.role === 'driver' ? 'company_admin' : 'it_admin',
      status, delivery_method: 'link', created_at: hoursAgo(i * 2 + 1),
      sent_at: ['completed', 'expired'].includes(status) ? hoursAgo(i * 2) : null,
      token_expires_at: status === 'expired' ? hoursAgo(i * 2 - 1 > 0 ? i * 2 - 1 : 0) : null,
      completed_at: status === 'completed' ? hoursAgo(i * 2 - 0.5 > 0 ? i * 2 - 0.5 : 0) : null,
    })
  }

  // audit + system logs
  const staffActors = [...admins, ...gms, ...opss, ...fleet]
  const AUDIT_TYPES = [['booking', 'booking_created'], ['user_management', 'user_updated'], ['vehicle_activity', 'vehicle_updated'], ['document_activity', 'document_approved'], ['auth', 'login'], ['driver_activity', 'trip_started']]
  for (let i = 0; i < N; i++) {
    const [type, action] = pick(AUDIT_TYPES, i)
    await ins('audit_logs', 'log_id', {
      user_id: pick(staffActors, i).id, log_type: type, action, description: `[seed] ${action.replace(/_/g, ' ')} #${pad(i + 1)}`, timestamp: hoursAgo(i),
    })
  }
  const SYS = [['info', 'cron_job'], ['warn', 'external_api'], ['error', 'server_error'], ['info', 'email_event'], ['critical', 'db_event'], ['warn', 'auth_event']]
  for (let i = 0; i < N; i++) {
    const [level, ev] = pick(SYS, i)
    await ins('system_logs', 'log_id', {
      log_level: level, event_type: ev, source: 'seed.ui-test-data', message: `[seed] ${ev.replace(/_/g, ' ')} test entry #${pad(i + 1)}`,
      metadata: JSON.stringify({ seed: true }), resolved: level === 'info', timestamp: hoursAgo(i),
    })
  }

  await db.query('COMMIT')
  saveManifest()
  console.log('Seeded:')
  for (const [t, ids] of Object.entries(manifest.tables)) console.log(`  ${t.padEnd(26)} ${ids.length}`)
  console.log(`  auth users                 ${manifest.auth_user_ids.length}`)
  console.log(`Manifest: ${MANIFEST}`)
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  manifest.tables = {}
  saveManifest()
  console.error('Seed failed; database rows rolled back. Auth users created so far are in the manifest — run the teardown to remove them.')
  console.error(err)
  process.exitCode = 1
} finally {
  db.release()
  await pool.end()
}
