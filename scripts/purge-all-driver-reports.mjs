/**
 * Removes every driver report — both the quick SOS alerts and the detailed
 * forms — along with their photos/videos on Cloudinary and the notifications
 * that were fanned out about them.
 *
 *   node scripts/purge-all-driver-reports.mjs --dry-run   # report only
 *   node scripts/purge-all-driver-reports.mjs             # delete
 *
 * Nothing references driver_reports, so the table can go first and alone. What
 * does NOT clean itself up is the notification fan-out: those rows carry the
 * report in `data->>'report_id'` and an `/admin/reports?report=<id>` action_url
 * rather than a foreign key, so deleting a report leaves staff inboxes holding
 * links to a page that no longer resolves. They are matched on that key here,
 * which also sweeps up notifications left behind by reports deleted earlier.
 *
 * Drivers, vehicles and users are untouched — a report is a record ABOUT a
 * driver, not part of one.
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

/** See purge-all-bookings.mjs — the URL states its own resource type. */
function assetFromUrl(url) {
  const m = /res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)$/.exec(url)
  if (!m) return null
  const [, resourceType, p] = m
  return {
    url,
    resource_type: resourceType,
    public_id: resourceType === 'raw' ? p : p.replace(/\.[^./]+$/, ''),
  }
}

const db = await pool.connect()
let assets = []

try {
  await db.query('BEGIN')

  const reports = (await db.query(
    `select report_id, source, incident_type, status from driver_reports order by created_at`
  )).rows

  // Counted separately: a report deleted earlier can still have notifications
  // pointing at it, and those are just as dead.
  const orphanNotifs = (await db.query(
    `select count(*)::int n from notifications
      where data ? 'report_id' and data->>'report_id' is not null
        and not exists (select 1 from driver_reports r where r.report_id::text = data->>'report_id')`
  )).rows[0].n

  if (!reports.length && !orphanNotifs) {
    console.log('No driver reports and no report notifications — nothing to do.')
    await db.query('ROLLBACK')
    process.exit(0)
  }

  const urls = (await db.query(
    `select unnest(coalesce(photo_urls, '{}')) as url from driver_reports
     union
     select unnest(coalesce(video_urls, '{}')) from driver_reports`
  )).rows.map((r) => r.url).filter(Boolean)

  const unparsed = []
  for (const url of [...new Set(urls)]) {
    const asset = assetFromUrl(url)
    if (asset) assets.push(asset)
    else unparsed.push(url)
  }

  console.log(`reports          : ${reports.length} — ${reports.map((r) => r.incident_type ?? r.source).join(', ')}`)
  console.log(`report notifs    : ${(await db.query(
    `select count(*)::int n from notifications where data->>'report_id' is not null`)).rows[0].n} (${orphanNotifs} already orphaned)`)
  console.log(`assets           : ${assets.length} on Cloudinary${unparsed.length ? ` (+${unparsed.length} UNPARSEABLE)` : ''}`)
  for (const u of unparsed) console.log(`   ?! ${u}`)
  console.log('')

  if (!dryRun) {
    const snapshot = {
      driver_reports: (await db.query(`select * from driver_reports`)).rows,
      notifications:  (await db.query(
        `select * from notifications where data->>'report_id' is not null`)).rows,
      cloudinary_assets: assets,
    }
    const dir = path.join(process.cwd(), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `purge-all-driver-reports-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2))
    console.log(`snapshot -> ${file}\n`)
  }

  const step = async (label, sql, params) => {
    const { rowCount } = await db.query(sql, params)
    console.log(`  ${label.padEnd(46)} ${rowCount}`)
  }

  await step('notifications (report fan-out)',
    `delete from notifications where data->>'report_id' is not null`, [])
  await step('driver_reports',
    `delete from driver_reports`, [])

  const after = (await db.query(`
    select 'driver_reports' t, count(*)::int n from driver_reports
    union all select 'notifications (kept)', count(*)::int from notifications
    union all select 'drivers (kept)',       count(*)::int from drivers
    union all select 'trucks (kept)',        count(*)::int from trucks
    union all select 'users (kept)',         count(*)::int from users
  `)).rows
  console.log('\nafter:')
  for (const r of after) console.log(`  ${r.t.padEnd(22)} ${r.n}`)

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
    console.log(`  ${(res.result === 'ok' ? 'ok' : res.result).padEnd(9)} ${a.resource_type.padEnd(5)} ${a.public_id}`)
  } catch (err) {
    console.log(`  fail      ${a.resource_type.padEnd(5)} ${a.public_id} — ${err.message}`)
  }
}

await pool.end()
process.exit(0)
