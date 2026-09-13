/**
 * Removes EVERY booking and everything that hangs off one, keeping the users,
 * drivers and vehicles that were assigned to them.
 *
 *   node scripts/purge-all-bookings.mjs --dry-run   # report only, rolls back
 *   node scripts/purge-all-bookings.mjs            # delete
 *
 * Survives the purge: users, clients, drivers, trucks, truck_models,
 * truck_inspections, driver_availability_days, commodities, products,
 * handling_codes, document_series, and every notification not tied to a booking
 * (password resets, standalone driver alerts).
 *
 * The delete order below is dictated by the foreign keys that are NOT
 * ON DELETE CASCADE — billing_period_items and service_invoices are RESTRICT,
 * and deliveries/ratings/expenses/emergency_alerts/maintenance_requests are
 * NO ACTION — so each of those has to go before the row it points at. Everything
 * with a CASCADE (booking_destinations, cargo items, trips and their stops,
 * driver/truck assignments, booking notifications, billing claims) is left to
 * the database and reported afterwards.
 *
 * billing_periods are dropped whole rather than zeroed: ensurePeriodsForClient()
 * only generates periods from unbilled completed bookings, so with no bookings
 * left they will not come back until there is real work to bill.
 *
 * The driver and vehicle that were reserved by a deleted booking are put back in
 * the pool exactly the way releaseCrew() does it — both to 'available'. Drivers
 * who were never on one of these bookings are not touched.
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

/**
 * A delivery URL carries its own resource type: Cloudinary serves every asset
 * from /<cloud>/<resource_type>/upload/. Raw assets are addressed by the path
 * with the extension left on; images and videos have it stripped.
 */
function assetFromUrl(url) {
  const m = /res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)$/.exec(url)
  if (!m) return null
  const [, resourceType, path] = m
  return {
    url,
    resource_type: resourceType,
    public_id: resourceType === 'raw' ? path : path.replace(/\.[^./]+$/, ''),
  }
}

const db = await pool.connect()
let assets = []

try {
  await db.query('BEGIN')

  const bookings = (await db.query(
    `select booking_id, reference_number, status from bookings order by reference_number`
  )).rows
  const bookingIds = bookings.map((r) => r.booking_id)

  if (!bookingIds.length) {
    console.log('No bookings found — nothing to do.')
    await db.query('ROLLBACK')
    process.exit(0)
  }

  const deliveries = (await db.query(
    `select delivery_id, driver_id, truck_id from deliveries where booking_id = any($1::uuid[])`,
    [bookingIds],
  )).rows
  const deliveryIds = deliveries.map((r) => r.delivery_id)

  const invoiceIds = (await db.query(
    `select invoice_id from service_invoices where booking_id = any($1::uuid[])`, [bookingIds],
  )).rows.map((r) => r.invoice_id)

  // Every period is generated from bookings, so with all bookings going they all go.
  const periodIds = (await db.query(`select period_id from billing_periods`)).rows.map((r) => r.period_id)

  // The crew this purge is responsible for releasing — whoever a deleted booking
  // reserved, whether through its delivery or through the assignment tables.
  const driverIds = [...new Set((await db.query(
    `select driver_id from deliveries        where booking_id = any($1::uuid[]) and driver_id is not null
     union
     select driver_id from driver_assignments where booking_id = any($1::uuid[]) and driver_id is not null`,
    [bookingIds],
  )).rows.map((r) => r.driver_id))]

  const truckIds = [...new Set((await db.query(
    `select truck_id from deliveries        where booking_id = any($1::uuid[]) and truck_id is not null
     union
     select truck_id from truck_assignments where booking_id = any($1::uuid[]) and truck_id is not null`,
    [bookingIds],
  )).rows.map((r) => r.truck_id))]

  // Cloudinary URLs, collected while the rows are still here.
  const urls = (await db.query(
    `select pickup_proof_photo_url as url from bookings where pickup_proof_photo_url is not null
     union all
     select unnest(transaction_documents) from bookings where transaction_documents is not null
     union all
     select proof_photo_url from booking_destinations where proof_photo_url is not null
     union all
     select s.proof_photo_url from booking_trip_stops s
       join booking_trips t on t.trip_id = s.trip_id
      where s.proof_photo_url is not null
     union all
     select unnest(photo_urls) from driver_reports where booking_id = any($1::uuid[]) and photo_urls is not null
     union all
     select unnest(video_urls) from driver_reports where booking_id = any($1::uuid[]) and video_urls is not null
     union all
     select pdf_url from service_invoices where pdf_url is not null
     union all
     select pdf_url from acknowledgement_receipts where pdf_url is not null`,
    [bookingIds],
  )).rows.map((r) => r.url).filter(Boolean)

  const unparsed = []
  for (const url of [...new Set(urls)]) {
    const asset = assetFromUrl(url)
    if (asset) assets.push(asset)
    else unparsed.push(url)
  }

  console.log(`bookings   : ${bookings.map((r) => `${r.reference_number}(${r.status})`).join(', ')}`)
  console.log(`deliveries : ${deliveryIds.length}`)
  console.log(`invoices   : ${invoiceIds.length}`)
  console.log(`periods    : ${periodIds.length}`)
  console.log(`crew back  : ${driverIds.length} driver(s), ${truckIds.length} vehicle(s)`)
  console.log(`assets     : ${assets.length} on Cloudinary${unparsed.length ? ` (+${unparsed.length} UNPARSEABLE)` : ''}`)
  for (const u of unparsed) console.log(`   ?! ${u}`)
  console.log('')

  // Everything about to be destroyed, written out while it still exists. The
  // Cloudinary URLs live in here too, which is what makes a re-upload possible.
  if (!dryRun) {
    const snapshot = {}
    const capture = async (name, sql, params) => {
      snapshot[name] = (await db.query(sql, params)).rows
    }
    await capture('bookings', `select * from bookings`)
    await capture('booking_destinations', `select * from booking_destinations`)
    await capture('booking_cargo_items', `select * from booking_cargo_items`)
    await capture('booking_trips', `select * from booking_trips`)
    await capture('booking_trip_stops', `select * from booking_trip_stops`)
    await capture('deliveries', `select * from deliveries where booking_id = any($1::uuid[])`, [bookingIds])
    await capture('driver_assignments', `select * from driver_assignments where booking_id = any($1::uuid[])`, [bookingIds])
    await capture('truck_assignments', `select * from truck_assignments where booking_id = any($1::uuid[])`, [bookingIds])
    await capture('driver_reports', `select * from driver_reports where booking_id = any($1::uuid[])`, [bookingIds])
    await capture('billing_periods', `select * from billing_periods`)
    await capture('billing_period_items', `select * from billing_period_items`)
    await capture('billing_booking_claims', `select * from billing_booking_claims`)
    await capture('billing_submissions', `select * from billing_submissions`)
    await capture('service_invoices', `select * from service_invoices`)
    await capture('acknowledgement_receipts', `select * from acknowledgement_receipts`)
    await capture('notifications', `select * from notifications where booking_id is not null`)
    await capture('booking_reference_counters', `select * from booking_reference_counters`)
    snapshot.cloudinary_assets = assets

    const dir = path.join(process.cwd(), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `purge-all-bookings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2))
    console.log(`snapshot -> ${file}\n`)
  }

  const step = async (label, sql, params) => {
    const { rowCount } = await db.query(sql, params)
    console.log(`  ${label.padEnd(46)} ${rowCount}`)
  }

  // Innermost dependant first, as the RESTRICT / NO ACTION constraints demand.
  await step('acknowledgement_receipts',
    `delete from acknowledgement_receipts where invoice_id = any($1::uuid[])`, [invoiceIds])
  await step('billing_payments',
    `delete from billing_payments where invoice_id = any($1::uuid[])`, [invoiceIds])
  await step('service_invoices',
    `delete from service_invoices where booking_id = any($1::uuid[])`, [bookingIds])
  // Cascades billing_period_items, billing_booking_claims and billing_submissions.
  await step('billing_periods (+cascades)',
    `delete from billing_periods where period_id = any($1::uuid[])`, [periodIds])
  await step('driver_reports (booking-linked only)',
    `delete from driver_reports where booking_id = any($1::uuid[])`, [bookingIds])
  await step('ratings',
    `delete from ratings where booking_id = any($1::uuid[])`, [bookingIds])
  await step('expenses',
    `delete from expenses where booking_id = any($1::uuid[]) or delivery_id = any($2::uuid[])`,
    [bookingIds, deliveryIds])
  await step('emergency_alerts',
    `delete from emergency_alerts where delivery_id = any($1::uuid[])`, [deliveryIds])
  await step('maintenance_requests',
    `delete from maintenance_requests where delivery_id = any($1::uuid[])`, [deliveryIds])
  await step('documents',
    `delete from documents where delivery_id = any($1::uuid[])`, [deliveryIds])
  await step('gps_tracking',
    `delete from gps_tracking where delivery_id = any($1::uuid[])`, [deliveryIds])
  // Position pings taken during a booking are part of that booking's record.
  // driver_locations is the driver's CURRENT position, not a booking detail, so
  // it keeps its row and just loses the booking_id (ON DELETE SET NULL).
  await step('driver_location_history',
    `delete from driver_location_history where booking_id = any($1::uuid[])`, [bookingIds])
  await step('deliveries',
    `delete from deliveries where booking_id = any($1::uuid[])`, [bookingIds])
  // Cascades booking_destinations, booking_cargo_items, booking_trips (and their
  // stops), driver_assignments, truck_assignments, booking notifications and
  // billing_booking_claims.
  await step('bookings (+cascades)',
    `delete from bookings where booking_id = any($1::uuid[])`, [bookingIds])
  // Next booking starts the month's sequence again at 00001.
  await step('booking_reference_counters reset',
    `delete from booking_reference_counters`, [])
  // Same landing spot releaseCrew() uses, and only for a reservation this purge
  // is actually dissolving.
  await step("drivers 'assigned' -> 'available'",
    `update drivers set status = 'available', updated_at = now()
      where driver_id = any($1::uuid[]) and status = 'assigned'`, [driverIds])
  await step("trucks 'in_use' -> 'available'",
    `update trucks set status = 'available', updated_at = now()
      where truck_id = any($1::uuid[]) and status = 'in_use'`, [truckIds])

  const leftovers = (await db.query(`
    select 'bookings' t, count(*)::int n from bookings
    union all select 'deliveries',           count(*)::int from deliveries
    union all select 'booking_destinations', count(*)::int from booking_destinations
    union all select 'booking_cargo_items',  count(*)::int from booking_cargo_items
    union all select 'booking_trips',        count(*)::int from booking_trips
    union all select 'booking_trip_stops',   count(*)::int from booking_trip_stops
    union all select 'driver_assignments',   count(*)::int from driver_assignments
    union all select 'truck_assignments',    count(*)::int from truck_assignments
    union all select 'billing_periods',      count(*)::int from billing_periods
    union all select 'billing_period_items', count(*)::int from billing_period_items
    union all select 'billing_booking_claims', count(*)::int from billing_booking_claims
    union all select 'notifications (booking)', count(*)::int from notifications where booking_id is not null
    union all select 'notifications (kept)',    count(*)::int from notifications where booking_id is null
    union all select 'users (kept)',            count(*)::int from users
    union all select 'drivers (kept)',          count(*)::int from drivers
    union all select 'trucks (kept)',           count(*)::int from trucks
    union all select 'driver_reports (kept)',   count(*)::int from driver_reports
    union all select 'truck_inspections (kept)', count(*)::int from truck_inspections
  `)).rows
  console.log('\nafter:')
  for (const r of leftovers) console.log(`  ${r.t.padEnd(26)} ${r.n}`)

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

// Only once the rows are gone, so a Cloudinary failure cannot leave a live
// booking pointing at a deleted photo.
console.log('\nCloudinary:')
for (const a of assets) {
  try {
    const res = await cloudinary.uploader.destroy(a.public_id, { resource_type: a.resource_type, invalidate: true })
    console.log(`  ${(res.result === 'ok' ? 'ok' : res.result).padEnd(9)} ${a.resource_type.padEnd(5)} ${a.public_id}`)
  } catch (err) {
    console.log(`  fail      ${a.resource_type.padEnd(5)} ${a.public_id} — ${err.message}`)
  }
}

await pool.end()
process.exit(0)
