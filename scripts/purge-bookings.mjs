/**
 * Delete every booking and everything hanging off it: destinations, trips,
 * stops, cargo, deliveries, assignments, location pings, booking documents,
 * booking notifications, and their storage files. Users, clients, drivers
 * and vehicles stay (a reference from them is nulled, never deleted); trucks
 * left 'in_use' and drivers left 'assigned' go back to 'available'; booking
 * numbering restarts.
 *
 *   node scripts/purge-bookings.mjs --dry-run   # report only, rolls back
 *   node scripts/purge-bookings.mjs            # delete
 *
 * Same live-FK walk as purge-users-except-it-admin.mjs, so it does not go
 * stale when tables are added or dropped (purge-all-bookings.mjs did).
 * A JSON backup of every deleted row is written before COMMIT.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { FILE_REF, assetFromRef, deleteStoredFile } from './lib/stored-files.mjs'

const dryRun = process.argv.includes('--dry-run')

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
pool.on('error', (err) => console.error('pool client error:', err.message))

const KEEP_TABLES = new Set([
  'public.users', 'public.clients', 'public.drivers', 'public.trucks', 'public.truck_models',
])

const db = await pool.connect()
const snapshot = {}, deleted = {}, nulled = [], urls = new Set()

try {
  await db.query('BEGIN')

  const fks = (await db.query(`
    select con.conrelid::regclass::text  as child,  ca.attname as col, not ca.attnotnull as nullable,
           con.confrelid::regclass::text as parent, pa.attname as parent_col,
           con.confdeltype as rule, array_length(con.conkey, 1) as ncols
      from pg_constraint con
      join pg_attribute ca on ca.attrelid = con.conrelid  and ca.attnum = con.conkey[1]
      join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
     where con.contype = 'f' and con.connamespace = 'public'::regnamespace`)).rows
  const qualify = (t) => (t.includes('.') ? t : `public.${t}`)
  for (const f of fks) { f.child = qualify(f.child); f.parent = qualify(f.parent) }

  const capture = async (table, where) => {
    const rows = []
    for (let offset = 0; ; offset += 200) {
      const page = (await db.query(`select * from ${table} where ${where} order by ctid limit 200 offset ${offset}`)).rows
      rows.push(...page)
      if (page.length < 200) break
    }
    for (const r of rows) for (const u of JSON.stringify(r).match(FILE_REF) ?? []) urls.add(u)
    ;(snapshot[table] ??= []).push(...rows)
  }

  const purge = async (table, where, depth = 0) => {
    if (depth > 12) throw new Error(`dependency chain too deep at ${table}`)
    const { rows: [{ n }] } = await db.query(`select count(*)::int n from ${table} where ${where}`)
    if (n === 0) return
    for (const f of fks.filter((f) => f.parent === table && f.rule !== 'n' && f.rule !== 'd')) {
      if (f.ncols !== 1) throw new Error(`multi-column FK ${f.child} -> ${table} not handled`)
      const childWhere = `${f.col} in (select ${f.parent_col} from ${table} where ${where})`
      if (KEEP_TABLES.has(f.child) || f.child === table) {
        const { rowCount } = await db.query(`update ${f.child} set ${f.col} = null where ${childWhere}`)
        if (rowCount && !f.nullable) throw new Error(`${f.child}.${f.col} is NOT NULL, cannot detach`)
        if (rowCount) nulled.push(`${f.child}.${f.col}`.padEnd(44) + ` ${rowCount}`)
        continue
      }
      await purge(f.child, childWhere, depth + 1)
    }
    await capture(table, where)
    const { rowCount } = await db.query(`delete from ${table} where ${where}`)
    deleted[table] = (deleted[table] ?? 0) + rowCount
  }

  // Booking notifications may be ON DELETE SET NULL, which would leave them
  // behind pointing at nothing; they are part of the booking, so take them.
  await purge('public.notifications', `booking_id is not null`)
  await purge('public.bookings', 'true')
  await purge('public.booking_reference_counters', 'true')

  const { rowCount: trucksFreed }  = await db.query(`update trucks  set status = 'available' where status = 'in_use'`)
  const { rowCount: driversFreed } = await db.query(`update drivers set status = 'available' where status = 'assigned'`)

  console.log('deleted:')
  for (const [t, n] of Object.entries(deleted).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(44)} ${n}`)
  if (nulled.length) { console.log('\ndetached (set to null):'); for (const l of nulled) console.log(`  ${l}`) }
  console.log(`\ntrucks in_use -> available                    ${trucksFreed}`)
  console.log(`drivers assigned -> available                 ${driversFreed}`)
  console.log(`bookings left: ${(await db.query(`select count(*)::int n from bookings`)).rows[0].n}`)

  const assets = [], unparsed = []
  for (const u of urls) { const a = assetFromRef(u); a ? assets.push(a) : unparsed.push(u) }
  console.log(`\nstored files to delete: ${assets.length}${unparsed.length ? ` (+${unparsed.length} unparseable)` : ''}`)
  for (const u of unparsed) console.log(`   ?! ${u}`)

  if (dryRun) {
    await db.query('ROLLBACK')
    console.log('\nDRY RUN — rolled back, nothing changed. stored files untouched.')
    db.release(); await pool.end(); process.exit(0)
  }

  const dir = path.join(process.cwd(), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `purge-bookings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify({ deleted: snapshot, nulled }, null, 2))
  console.log(`\nsnapshot -> ${file}`)

  await db.query('COMMIT')
  console.log('Database committed.')
  db.release()

  console.log('\nStored files:')
  for (const a of assets) {
    console.log(`  ${(await deleteStoredFile(a)).padEnd(9)} ${a.key}`)
  }
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('\nRolled back, nothing changed:', err.message)
  db.release(); await pool.end(); process.exit(1)
}

await pool.end()
process.exit(0)
