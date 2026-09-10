/**
 * Removes the `[seed]` bookings created by seed-billable-bookings.ts, along with
 * everything reverse billing built on top of them, and rewinds both BIR serial
 * booklets.
 *
 *   node scripts/teardown-seed-bookings.mjs --dry-run   # report only
 *   node scripts/teardown-seed-bookings.mjs             # delete
 *
 * seed-billable-bookings.ts --clean cannot do this. Its `delete from bookings`
 * aborts on two ON DELETE RESTRICT foreign keys (billing_period_items and
 * service_invoices) the moment the seeded bookings have actually been billed,
 * which is the whole point of seeding them. The deletes below run in the order
 * those constraints demand, inside one transaction.
 *
 * The billing period is dropped rather than zeroed: ensurePeriodsForClient()
 * only generates periods from unbilled completed bookings, so with the seeds
 * gone it will not come back until there is real work to bill.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
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
 * Cloudinary addresses a raw asset by the path between `/upload/<version>/` and
 * the end of the URL, extension included — unlike an image, where it is left
 * off. Everything here was uploaded as raw.
 */
function publicIdFromUrl(url) {
  const m = /\/upload\/(?:v\d+\/)?(.+)$/.exec(url)
  return m ? m[1] : null
}

const db = await pool.connect()
let pdfUrls = []

try {
  await db.query('BEGIN')

  const ids = (await db.query(
    `select booking_id, reference_number from bookings where origin like '[seed]%'`
  )).rows
  const bookingIds = ids.map((r) => r.booking_id)

  if (!bookingIds.length) {
    console.log('No [seed] bookings found — nothing to do.')
    await db.query('ROLLBACK')
    process.exit(0)
  }

  const invoices = (await db.query(
    `select invoice_id, si_number, pdf_url from service_invoices where booking_id = any($1::uuid[])`,
    [bookingIds],
  )).rows
  const invoiceIds = invoices.map((r) => r.invoice_id)

  const receipts = (await db.query(
    `select ar_id, ar_number, pdf_url from acknowledgement_receipts where invoice_id = any($1::uuid[])`,
    [invoiceIds],
  )).rows

  const periodIds = [...new Set((await db.query(
    `select period_id from billing_period_items where booking_id = any($1::uuid[])`,
    [bookingIds],
  )).rows.map((r) => r.period_id))]

  pdfUrls = [...invoices, ...receipts].map((r) => r.pdf_url).filter(Boolean)

  console.log(`bookings : ${ids.map((r) => r.reference_number).join(', ')}`)
  console.log(`invoices : ${invoices.map((r) => `SI ${r.si_number}`).join(', ') || '(none)'}`)
  console.log(`receipts : ${receipts.map((r) => `AR ${r.ar_number}`).join(', ') || '(none)'}`)
  console.log(`periods  : ${periodIds.length}`)
  console.log(`pdfs     : ${pdfUrls.length}\n`)

  const step = async (label, sql, params) => {
    const { rowCount } = await db.query(sql, params)
    console.log(`  ${label.padEnd(46)} ${rowCount}`)
  }

  // Order is dictated by the RESTRICT constraints, innermost dependant first.
  await step('acknowledgement_receipts',
    `delete from acknowledgement_receipts where invoice_id = any($1::uuid[])`, [invoiceIds])
  await step('billing_payments',
    `delete from billing_payments where invoice_id = any($1::uuid[])`, [invoiceIds])
  await step('service_invoices',
    `delete from service_invoices where invoice_id = any($1::uuid[])`, [invoiceIds])
  // Cascades billing_period_items, billing_booking_claims and billing_submissions.
  await step('billing_periods (+cascades)',
    `delete from billing_periods where period_id = any($1::uuid[])`, [periodIds])
  // Cascades booking_destinations, cargo items, assignments and notifications.
  await step('bookings (+cascades)',
    `delete from bookings where booking_id = any($1::uuid[])`, [bookingIds])
  // Rewind both booklets to the start of the pad.
  await step('document_series reset to booklet_start',
    `update document_series set next_number = coalesce(booklet_start, 1), updated_at = now()`, [])

  if (dryRun) {
    await db.query('ROLLBACK')
    console.log('\nDRY RUN — rolled back, nothing changed.')
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

// Only once the rows are gone, so a Cloudinary failure cannot leave live
// invoices pointing at deleted PDFs. Re-runnable: the URLs are in the backup.
console.log('\nCloudinary:')
for (const url of pdfUrls) {
  const publicId = publicIdFromUrl(url)
  if (!publicId) {
    console.log(`  ?  could not parse public_id from ${url}`)
    continue
  }
  try {
    const res = await cloudinary.uploader.destroy(publicId, { resource_type: 'raw', invalidate: true })
    console.log(`  ${res.result === 'ok' ? 'ok  ' : res.result.padEnd(4)} ${publicId}`)
  } catch (err) {
    console.log(`  fail ${publicId} — ${err.message}`)
  }
}

await pool.end()

const series = (await new pg.Pool({
  connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false },
}).query(`select series_key, next_number from document_series order by series_key`)).rows
console.log('\nseries now:', series.map((s) => `${s.series_key}=${s.next_number}`).join('  '))
process.exit(0)
