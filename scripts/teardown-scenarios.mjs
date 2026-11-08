/**
 * Removes what seed-scenarios.mjs inserted, by the ids in
 * scripts/seed-scenarios.manifest.json, plus its auth users and stored files.
 *
 *   npx tsx scripts/teardown-scenarios.mjs          # dry run: what would go, nothing deleted
 *   npx tsx scripts/teardown-scenarios.mjs --yes    # delete
 *
 * Rows the app or the schedulers created while the seed was in use and that
 * point at seed rows (a notification to a seed user, a reminder about a seed
 * booking, an audit entry by a seed account, a lock…) would block the deletes,
 * so they are found through the foreign keys and removed first. The dry run
 * lists them per table: read it before --yes, in case a REAL record got tied
 * to seed data (e.g. a real booking given a seed vehicle) and would go with it.
 *
 * Booking numbers: the seeded bookings used real BK- numbers. If no real
 * booking was made after the seed, the counters go back to where they were.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'

const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-scenarios.manifest.json')
const execute  = process.argv.includes('--yes')
if (!fs.existsSync(MANIFEST)) { console.error(`No manifest at ${MANIFEST}: nothing to tear down.`); process.exit(1) }
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
const s3 = new S3Client({
  region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
})
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const db   = await pool.connect()

const pkCache = new Map()
async function pkOf(table) {
  if (!pkCache.has(table)) {
    const { rows } = await db.query(`
      select pk.attname from pg_index i join pg_attribute pk on pk.attrelid = i.indrelid and pk.attnum = any(i.indkey)
       where i.indrelid = $1::regclass and i.indisprimary`, [`public.${table}`])
    pkCache.set(table, rows.length === 1 ? rows[0].attname : null)
  }
  return pkCache.get(table)
}
const fkCache = new Map()
/** Single-column FKs pointing at `table` that would block a delete (NO ACTION / RESTRICT). */
async function blockingRefs(table) {
  if (!fkCache.has(table)) {
    const { rows } = await db.query(`
      select c.conrelid::regclass::text as child, a.attname as child_col, not a.attnotnull as nullable
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = $1::regclass and c.confdeltype in ('a', 'r') and array_length(c.conkey, 1) = 1`, [`public.${table}`])
    fkCache.set(table, rows.map((r) => ({ ...r, child: r.child.replace(/^public\./, '') })))
  }
  return fkCache.get(table)
}

const seedIds = new Map(Object.entries(manifest.tables ?? {}).map(([t, ids]) => [t, new Set(ids.map(String))]))
const extras = new Map(), nulled = new Map()
// Columns on seed-referencing rows that are only a pointer, never ownership: cleared, not deleted.
const DETACH = new Set(['users.created_by', 'trucks.maintenance_booking_id', 'trucks.maintenance_report_id', 'bookings.delay_destination_id', 'bookings.breakdown_report_id'])

async function purge(table, ids, depth = 0) {
  if (!ids.length) return
  if (depth > 10) throw new Error(`dependency chain too deep at ${table}`)
  const pk = await pkOf(table)
  for (const fk of await blockingRefs(table)) {
    if (DETACH.has(`${fk.child}.${fk.child_col}`) && fk.nullable) {
      const n = (await db.query(`update ${fk.child} set ${fk.child_col} = null where ${fk.child_col}::text = any($1::text[])`, [ids])).rowCount
      if (n) nulled.set(`${fk.child}.${fk.child_col}`, (nulled.get(`${fk.child}.${fk.child_col}`) ?? 0) + n)
      continue
    }
    const childPk = await pkOf(fk.child)
    if (!childPk) {
      const n = (await db.query(`delete from ${fk.child} where ${fk.child_col}::text = any($1::text[])`, [ids])).rowCount
      if (n) extras.set(fk.child, (extras.get(fk.child) ?? 0) + n)
      continue
    }
    const childIds = (await db.query(`select ${childPk}::text id from ${fk.child} where ${fk.child_col}::text = any($1::text[])`, [ids])).rows.map((r) => r.id)
    const next = fk.child === table ? childIds.filter((id) => !ids.includes(id)) : childIds
    const own = seedIds.get(fk.child)
    const foreign = next.filter((id) => !own?.has(id))
    if (foreign.length) extras.set(fk.child, (extras.get(fk.child) ?? 0) + foreign.length)
    await purge(fk.child, next, depth + 1)
  }
  await db.query(`delete from ${table} where ${pk}::text = any($1::text[])`, [ids])
}

try {
  await db.query('BEGIN')
  // Cross-links among seed rows first, so the delete order doesn't matter.
  await db.query(`update trucks set maintenance_booking_id = null, maintenance_report_id = null where truck_id::text = any($1::text[])`, [[...(seedIds.get('trucks') ?? [])]])
  await db.query(`update bookings set delay_destination_id = null, breakdown_report_id = null where booking_id::text = any($1::text[])`, [[...(seedIds.get('bookings') ?? [])]])
  await db.query(`update group_members set last_read_message_id = null where id::text = any($1::text[])`, [[...(seedIds.get('group_members') ?? [])]])

  const counts = {}
  // Reverse insertion order: children were inserted after their parents.
  for (const table of Object.keys(manifest.tables).reverse()) {
    const ids = [...seedIds.get(table)]
    const pk = await pkOf(table)
    counts[table] = (await db.query(`select count(*)::int n from ${table} where ${pk}::text = any($1::text[])`, [ids])).rows[0].n
    await purge(table, ids)
  }

  // Booking numbers back to where they were, unless a real booking took one since.
  const before = new Map((manifest.counter_before ?? []).map((r) => [r.period, r.last_value]))
  const after  = new Map((manifest.counter_after ?? []).map((r) => [r.period, r.last_value]))
  const now    = new Map((await db.query(`select period, last_value from booking_reference_counters`)).rows.map((r) => [r.period, r.last_value]))
  const counterNotes = []
  for (const [period, last] of after) {
    if (now.get(period) !== last) { counterNotes.push(`${period}: real bookings were made since; counter left at ${now.get(period)}`); continue }
    if (before.has(period)) await db.query(`update booking_reference_counters set last_value = $2 where period = $1`, [period, before.get(period)])
    else await db.query(`delete from booking_reference_counters where period = $1`, [period])
    counterNotes.push(`${period}: reset to ${before.get(period) ?? 'none'}`)
  }

  console.log(execute ? 'Deleted seed rows:' : 'DRY RUN — would delete seed rows:')
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(30)} ${n}`)
  if (extras.size) {
    console.log('\nAlso removed because they pointed at seed rows (made by the app or schedulers while testing):')
    for (const [t, n] of extras) console.log(`  ${t.padEnd(30)} ${n}`)
  }
  if (nulled.size) {
    console.log('\nDetached (pointer set to null on a non-seed row):')
    for (const [c, n] of nulled) console.log(`  ${c.padEnd(30)} ${n}`)
  }
  console.log('\nBooking numbers:'); for (const l of counterNotes) console.log(`  ${l}`)

  if (!execute) {
    await db.query('ROLLBACK')
    console.log(`\nNothing was changed. ${manifest.auth_user_ids.length} auth users and ${manifest.files.length} files would also go. Re-run with --yes to delete.`)
  } else {
    await db.query('COMMIT')
    let authGone = 0
    for (const id of manifest.auth_user_ids ?? []) { const { error } = await supabase.auth.admin.deleteUser(id); if (!error) authGone++ }
    let filesGone = 0
    for (const key of manifest.files ?? []) { try { await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_FILES_BUCKET, Key: key })); filesGone++ } catch (e) { console.log(`  file not deleted: ${key} (${e.message})`) } }
    console.log(`\nAuth users removed through the admin API: ${authGone} (the rest went with their profiles). Files deleted: ${filesGone}/${manifest.files.length}.`)
    fs.renameSync(MANIFEST, MANIFEST.replace(/\.json$/, `.removed-${Date.now()}.json`))
    console.log('Manifest archived.')
  }
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('Teardown failed; nothing was deleted.')
  console.error(err)
  process.exitCode = 1
} finally {
  db.release()
  await pool.end()
}
