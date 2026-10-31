/**
 * Full user reset: permanently deletes every user except the single active IT
 * Administrator, plus everything that depends on them (their client / driver
 * records, every booking and delivery those carry, messages, groups,
 * notifications, audit logs, permissions, sessions...).
 *
 *   node scripts/purge-users-except-it-admin.mjs --dry-run   # report only, rolls back
 *   node scripts/purge-users-except-it-admin.mjs            # delete
 *
 * The dependency walk is read from the live foreign keys, not a hard-coded
 * table list (the base schema isn't in the repo and drifts):
 *   - ON DELETE SET NULL edges are left to Postgres.
 *   - CASCADE / NO ACTION edges are deleted child-first, recursively, so every
 *     removed row is captured in the backup and scanned for stored-file references.
 *   - Rows in KEEP_TABLES are never deleted; their reference is nulled instead
 *     (the IT Administrator's own users row, vehicles). A NOT NULL reference
 *     there aborts the whole run.
 * Auth identities go via the AFTER DELETE trigger on public.users.
 *
 * Afterwards there is no Company Administrator; the first one added becomes
 * the root administrator (earliest-created admin, see lib/protected-admin.ts),
 * the only account allowed to run the IT Administrator transition.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { FILE_REF, assetFromRef, deleteStoredFile } from './lib/stored-files.mjs'

const dryRun = process.argv.includes('--dry-run')

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
pool.on('error', (err) => console.error('pool client error:', err.message))

const KEEP_TABLES = new Set(['public.users', 'public.trucks', 'public.truck_models'])

const db = await pool.connect()
const snapshot = {}   // table -> deleted rows
const deleted  = {}   // table -> count
const nulled   = []   // "table.col  n"
const urls     = new Set()

try {
  await db.query('BEGIN')

  const itAdmins = (await db.query(
    `select user_id, email from public.users where role = 'it_admin' and status = 'active'`,
  )).rows
  if (itAdmins.length !== 1) throw new Error(`expected exactly 1 active IT Administrator, found ${itAdmins.length}`)
  const keepId = itAdmins[0].user_id
  console.log(`keeping IT Administrator ${itAdmins[0].email} (${keepId})\n`)

  // Every single-column FK in public, with its referenced column and nullability.
  const fks = (await db.query(`
    select con.conrelid::regclass::text  as child,
           ca.attname                    as col,
           not ca.attnotnull             as nullable,
           con.confrelid::regclass::text as parent,
           pa.attname                    as parent_col,
           con.confdeltype               as rule,
           array_length(con.conkey, 1)   as ncols
      from pg_constraint con
      join pg_attribute ca on ca.attrelid = con.conrelid  and ca.attnum = con.conkey[1]
      join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
     where con.contype = 'f'
       and con.connamespace = 'public'::regnamespace`)).rows
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
      if (KEEP_TABLES.has(f.child)) {
        // Self-reference on users: only rows that survive need nulling; the
        // rest are being deleted in this same statement.
        const survivors = f.child === table ? ` and not (${where})` : ''
        const { rowCount } = await db.query(
          `update ${f.child} set ${f.col} = null where ${childWhere}${survivors}`)
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

  const authBefore = (await db.query(`select count(*)::int n from auth.users`)).rows[0].n
  await purge('public.users', `user_id <> '${keepId}'`)

  // Vehicles stay; any left mid-delivery go back to available.
  const { rowCount: trucksFreed } = await db.query(
    `update trucks set status = 'available' where status = 'in_use'`)

  console.log('deleted:')
  for (const [t, n] of Object.entries(deleted).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(44)} ${n}`)
  if (nulled.length) { console.log('\ndetached (set to null):'); for (const l of nulled) console.log(`  ${l}`) }
  console.log(`\ntrucks in_use -> available                    ${trucksFreed}`)

  const usersLeft = (await db.query(`select role, count(*)::int n from public.users group by 1`)).rows
  const authLeft  = (await db.query(`select count(*)::int n from auth.users`)).rows[0].n
  console.log(`\npublic.users left: ${JSON.stringify(usersLeft)}`)
  console.log(`auth.users: ${authBefore} -> ${authLeft}`)
  if (authLeft !== 1) throw new Error(`expected 1 auth user left, found ${authLeft} — trigger did not fire?`)

  const assets = [], unparsed = []
  for (const u of urls) { const a = assetFromRef(u); a ? assets.push(a) : unparsed.push(u) }
  console.log(`\nstored files to delete: ${assets.length}${unparsed.length ? ` (+${unparsed.length} unparseable)` : ''}`)
  for (const u of unparsed) console.log(`   ?! ${u}`)

  if (dryRun) {
    await db.query('ROLLBACK')
    console.log('\nDRY RUN — rolled back, nothing changed. stored files untouched.')
    db.release(); await pool.end(); process.exit(0)
  }

  // Backup is written before COMMIT: if it can't be saved, nothing is deleted.
  const dir = path.join(process.cwd(), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `purge-users-except-it-admin-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify({ kept_it_admin: keepId, deleted: snapshot, nulled }, null, 2))
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
