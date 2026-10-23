/**
 * Removes what seed-ui-test-data.mjs inserted, by the ids in
 * scripts/seed-ui-test-data.manifest.json.
 *
 *   node scripts/teardown-ui-test-data.mjs          # dry run: what would go, nothing deleted
 *   node scripts/teardown-ui-test-data.mjs --yes    # delete
 *
 * Rows the app created while the seed was being tested and that point at seed
 * rows (a notification to a seed client, a crew assignment of a seed driver,
 * a lock, an audit entry by a seed user...) block the deletes, so they are
 * found through the foreign keys and removed first. The dry run lists them per
 * table: read it before --yes, in case a REAL record got tied to seed data
 * (e.g. a real booking given a seed vehicle) and would go with it.
 *
 * Deleting public.users fires users_delete_auth_user, which drops the auth
 * user too; any auth user left without a profile (a seed run that failed
 * part-way) is removed through the admin API at the end.
 *
 * WRITES TO WHATEVER DATABASE_URL POINTS AT, WHICH IS PRODUCTION.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-ui-test-data.manifest.json')
const execute  = process.argv.includes('--yes')

if (!fs.existsSync(MANIFEST)) {
  console.error(`No manifest at ${MANIFEST} — nothing to tear down.`)
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const db   = await pool.connect()

// Leaf tables first, users last.
const ORDER = [
  'booking_trip_cargo', 'booking_trip_stops', 'booking_trips', 'driver_assignments', 'booking_cargo_items',
  'documents', 'support_tickets', 'driver_reports', 'password_reset_requests', 'booking_destinations',
  'deliveries', 'bookings', 'truck_services', 'truck_odometer_readings', 'truck_inspections', 'trucks',
  'truck_models', 'audit_logs', 'system_logs', 'drivers', 'clients', 'users',
]

const fkCache = new Map()
/** Foreign keys that point at `table` and would block a delete (NO ACTION / RESTRICT). */
async function blockingRefs(table) {
  if (fkCache.has(table)) return fkCache.get(table)
  const { rows } = await db.query(`
    select c.conrelid::regclass::text as child,
           a.attname                  as child_col,
           pa.attname                 as parent_col,
           (select string_agg(pk.attname, ',')
              from pg_index i join pg_attribute pk on pk.attrelid = i.indrelid and pk.attnum = any(i.indkey)
             where i.indrelid = c.conrelid and i.indisprimary) as child_pk
      from pg_constraint c
      join pg_attribute a  on a.attrelid  = c.conrelid  and a.attnum  = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
     where c.contype = 'f' and c.confrelid = $1::regclass and c.confdeltype in ('a', 'r')
       and array_length(c.conkey, 1) = 1`, [`public.${table}`])
  fkCache.set(table, rows)
  return rows
}

const pkCache = new Map()
async function pkOf(table) {
  if (pkCache.has(table)) return pkCache.get(table)
  const { rows } = await db.query(`
    select pk.attname from pg_index i join pg_attribute pk on pk.attrelid = i.indrelid and pk.attnum = any(i.indkey)
     where i.indrelid = $1::regclass and i.indisprimary`, [`public.${table}`])
  const pk = rows.length === 1 ? rows[0].attname : null
  pkCache.set(table, pk)
  return pk
}

const seedIds = new Map(Object.entries(manifest.tables ?? {}).map(([t, ids]) => [t, new Set(ids)]))
const extras  = new Map()  // table -> count of non-manifest rows removed because they pointed at seed rows

/** Delete `ids` from `table`, clearing whatever still points at them first. */
async function purge(table, ids, depth = 0) {
  if (!ids.length || depth > 8) return
  const pk = await pkOf(table)
  for (const fk of await blockingRefs(table)) {
    const childTable = fk.child.replace(/^public\./, '')
    if (fk.child_pk && !fk.child_pk.includes(',')) {
      const childIds = (await db.query(
        `select ${fk.child_pk}::text as id from ${fk.child} where ${fk.child_col}::text = any($1::text[])`, [ids],
      )).rows.map((r) => r.id)
      const own = seedIds.get(childTable)
      const foreign = childIds.filter((id) => !own?.has(id))
      if (foreign.length) extras.set(childTable, (extras.get(childTable) ?? 0) + foreign.length)
      // Self-references (users.created_by) only matter for rows outside this batch.
      const next = childTable === table ? childIds.filter((id) => !ids.includes(id)) : childIds
      await purge(childTable, next, depth + 1)
    } else {
      const n = (await db.query(`delete from ${fk.child} where ${fk.child_col}::text = any($1::text[])`, [ids])).rowCount
      if (n) extras.set(childTable, (extras.get(childTable) ?? 0) + n)
    }
  }
  await db.query(`delete from ${table} where ${pk}::text = any($1::text[])`, [ids])
}

try {
  await db.query('BEGIN')
  const counts = {}
  for (const table of ORDER) {
    const ids = [...(seedIds.get(table) ?? [])]
    if (!ids.length) continue
    const present = (await db.query(`select count(*)::int n from ${table} where ${await pkOf(table)}::text = any($1::text[])`, [ids])).rows[0].n
    counts[table] = present
    await purge(table, ids)
  }

  console.log(execute ? 'Deleted seed rows:' : 'DRY RUN — would delete seed rows:')
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(26)} ${n}`)
  if (extras.size) {
    console.log('\nAlso removed because they pointed at seed rows (created by the app while testing):')
    for (const [t, n] of extras) console.log(`  ${t.padEnd(26)} ${n}`)
  }

  if (!execute) {
    await db.query('ROLLBACK')
    console.log('\nNothing was changed. Re-run with --yes to delete.')
  } else {
    await db.query('COMMIT')
    // Auth users without a profile (users_delete_auth_user covered the rest).
    let authGone = 0
    for (const id of manifest.auth_user_ids ?? []) {
      const { error } = await supabase.auth.admin.deleteUser(id)
      if (!error) authGone++
    }
    console.log(`\nAuth users removed through the admin API: ${authGone} (the rest went with their profiles).`)
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
