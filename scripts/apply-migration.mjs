import { readFileSync } from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import pg from 'pg'

/**
 * Apply a migration file to the database the backend itself reads.
 *
 *   node scripts/apply-migration.mjs supabase/migrations/<file>.sql
 *
 * There's no Supabase CLI wired up in this repo — supabase/migrations is just a
 * folder of SQL — so migrations were being applied by hand in the dashboard,
 * which is how one of them ended up on the wrong project while the API kept
 * failing on the missing columns. This runs the file against DATABASE_URL, the
 * same connection the app uses, so it can only land where the app will read it.
 *
 * The whole file runs in ONE transaction: either all of it applies or none of
 * it does. Afterwards PostgREST is told to re-read the schema, without which it
 * keeps reporting new columns as non-existent from its cache.
 */

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/apply-migration.mjs <path-to.sql>')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — check your .env')
  process.exit(1)
}

const fullPath = path.resolve(process.cwd(), file)
const sql      = readFileSync(fullPath, 'utf8')
const host     = process.env.DATABASE_URL.replace(/^.*@/, '').split('/')[0]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()

try {
  console.log(`applying ${path.basename(fullPath)} → ${host}`)
  await client.query('BEGIN')
  await client.query(sql)
  await client.query('COMMIT')
  console.log('applied.')

  // PostgREST caches the schema; new columns stay invisible to the API until
  // it reloads, which looks exactly like the migration never ran.
  await client.query("notify pgrst, 'reload schema'")
  console.log("PostgREST schema reload signalled.")
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error('FAILED — rolled back, nothing was changed.')
  console.error(err.message)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
