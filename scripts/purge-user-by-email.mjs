/**
 * Permanently deletes ONE user (by email) and everything that depends on them
 * (their client / driver record, bookings and deliveries those carry, messages,
 * notifications, audit logs, permissions, sessions...), plus the Cloudinary
 * files referenced by the deleted rows. Same dependency walk as
 * purge-users-except-it-admin.mjs.
 *
 *   node scripts/purge-user-by-email.mjs <email> --dry-run   # report only, rolls back
 *   node scripts/purge-user-by-email.mjs <email>             # delete
 *
 * Refuses the active IT Administrator. A JSON backup of every deleted row is
 * written to backups/ before COMMIT.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { v2 as cloudinary } from 'cloudinary'

const dryRun = process.argv.includes('--dry-run')
const email  = process.argv.slice(2).find((a) => !a.startsWith('--'))?.trim().toLowerCase()
if (!email) { console.error('usage: node scripts/purge-user-by-email.mjs <email> [--dry-run]'); process.exit(1) }

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
pool.on('error', (err) => console.error('pool client error:', err.message))

const KEEP_TABLES = new Set(['public.users', 'public.trucks', 'public.truck_models'])
const CLOUDINARY_URL = /https?:\/\/res\.cloudinary\.com\/[^"\s\\]+/g

function assetFromUrl(url) {
  const m = /res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)$/.exec(url)
  if (!m) return null
  const [, resourceType, p] = m
  return { url, resource_type: resourceType, public_id: resourceType === 'raw' ? p : p.replace(/\.[^./]+$/, '') }
}

const db = await pool.connect()
const snapshot = {}   // table -> deleted rows
const deleted  = {}   // table -> count
const nulled   = []   // "table.col  n"
const urls     = new Set()

try {
  await db.query('BEGIN')

  const targets = (await db.query(
    `select user_id, email, role, status, first_name, last_name, created_at from public.users where lower(email) = $1`, [email],
  )).rows
  const authOnly = (await db.query(`select id, email from auth.users where lower(email) = $1`, [email])).rows
  console.log('public.users match:', JSON.stringify(targets, null, 2))
  console.log('auth.users match:  ', JSON.stringify(authOnly))
  if (targets.length !== 1) throw new Error(`expected exactly 1 public.users row for ${email}, found ${targets.length}`)
  if (targets[0].role === 'it_admin' && targets[0].status === 'active') throw new Error('refusing to delete the active IT Administrator')
  const targetId = targets[0].user_id
  console.log('')

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
    for (const r of rows) for (const u of JSON.stringify(r).match(CLOUDINARY_URL) ?? []) urls.add(u)
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
  await purge('public.users', `user_id = '${targetId}'`)

  // Vehicles stay. One left 'in_use' by a deleted booking, with no live booking
  // still holding it, goes back to available.
  const touchedTrucks = [...new Set((snapshot['public.truck_assignments'] ?? []).map((r) => r.truck_id).filter(Boolean))]
  let trucksFreed = 0
  if (touchedTrucks.length) {
    ;({ rowCount: trucksFreed } = await db.query(`
      update trucks t set status = 'available'
       where t.truck_id = any($1) and t.status = 'in_use'
         and not exists (select 1 from truck_assignments ta join bookings b on b.booking_id = ta.booking_id
                          where ta.truck_id = t.truck_id and b.status in ('assigned', 'in_transit'))`, [touchedTrucks]))
  }

  console.log('deleted:')
  for (const [t, n] of Object.entries(deleted).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(44)} ${n}`)
  if (nulled.length) { console.log('\ndetached (set to null):'); for (const l of nulled) console.log(`  ${l}`) }
  console.log(`\ntrucks in_use -> available                    ${trucksFreed}`)

  const authLeft  = (await db.query(`select count(*)::int n from auth.users`)).rows[0].n
  const stillAuth = (await db.query(`select count(*)::int n from auth.users where lower(email) = $1`, [email])).rows[0].n
  console.log(`\nauth.users: ${authBefore} -> ${authLeft}`)
  if (stillAuth !== 0) throw new Error(`auth user for ${email} still present — trigger did not fire?`)

  const assets = [], unparsed = []
  for (const u of urls) { const a = assetFromUrl(u); a ? assets.push(a) : unparsed.push(u) }
  console.log(`\ncloudinary assets to delete: ${assets.length}${unparsed.length ? ` (+${unparsed.length} unparseable)` : ''}`)
  for (const u of unparsed) console.log(`   ?! ${u}`)

  if (dryRun) {
    await db.query('ROLLBACK')
    console.log('\nDRY RUN — rolled back, nothing changed. Cloudinary untouched.')
    db.release(); await pool.end(); process.exit(0)
  }

  // Backup is written before COMMIT: if it can't be saved, nothing is deleted.
  const dir = path.join(process.cwd(), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `purge-user-${email.replace(/[^a-z0-9]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify({ email, user_id: targetId, deleted: snapshot, nulled }, null, 2))
  console.log(`\nsnapshot -> ${file}`)

  await db.query('COMMIT')
  console.log('Database committed.')
  db.release()

  console.log('\nCloudinary:')
  for (const a of assets) {
    try {
      const res = await cloudinary.uploader.destroy(a.public_id, { resource_type: a.resource_type, invalidate: true })
      console.log(`  ${String(res.result).padEnd(9)} ${a.resource_type.padEnd(5)} ${a.public_id}`)
    } catch (err) {
      console.log(`  fail      ${a.resource_type.padEnd(5)} ${a.public_id} — ${err.message}`)
    }
  }
} catch (err) {
  await db.query('ROLLBACK').catch(() => {})
  console.error('\nRolled back, nothing changed:', err.message)
  db.release(); await pool.end(); process.exit(1)
}

await pool.end()
process.exit(0)
