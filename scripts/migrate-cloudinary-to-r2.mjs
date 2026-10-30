import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import 'dotenv/config'
import pg from 'pg'
import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3'

/**
 * One-time move of every Cloudinary file the database points at into the
 * private R2 bucket (see src/lib/storage.ts), rewriting each value to its
 * `r2://<key>` reference.
 *
 *   node scripts/migrate-cloudinary-to-r2.mjs           # dry run: lists what it would move
 *   node scripts/migrate-cloudinary-to-r2.mjs --apply   # copies files, then rewrites the DB
 *
 * Finds the URLs by scanning every text, text[] and json(b) column in public,
 * so a column nobody remembered is still covered. Files are copied first; the
 * database is only touched once every copy succeeded, in ONE transaction. The
 * Cloudinary originals are left alone, and a manifest (old URL → new ref) is
 * written next to this script so the rewrite can be reversed.
 *
 * DATABASE_URL in .env is PRODUCTION.
 */

const APPLY   = process.argv.includes('--apply')
const BUCKET  = process.env.R2_FILES_BUCKET
const ACCOUNT = process.env.R2_ACCOUNT_ID
if (!process.env.DATABASE_URL || !BUCKET || !ACCOUNT) {
  console.error('DATABASE_URL, R2_ACCOUNT_ID and R2_FILES_BUCKET must be set — check your .env')
  process.exit(1)
}

const s3 = new S3Client({
  region:         'auto',
  endpoint:       `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const URL_RE = /https:\/\/res\.cloudinary\.com\/[^"'\s,}\]]+/g

/** Same key shapes the live uploaders use: documents keep their name, the rest get <uuid>.<ext>. */
function keyFor(url) {
  const path  = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\/\w+\/upload\/(?:v\d+\/)?/, ''))
  const parts = path.split('/')
  const name  = parts.pop()
  const dir   = parts.join('/') || 'misc'
  if (dir.startsWith('booking_documents')) return `${dir}/${randomUUID()}/${name}`
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'jpg'
  return `${dir}/${randomUUID()}.${ext}`
}

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()

try {
  const host = process.env.DATABASE_URL.replace(/^.*@/, '').split('/')[0]
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} → db ${host}, bucket ${BUCKET}\n`)
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))

  const cols = (await client.query(`
    select c.table_name, c.column_name, c.data_type, c.udt_name
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
       and (c.data_type in ('text', 'character varying', 'json', 'jsonb') or c.udt_name in ('_text', '_varchar'))
  `)).rows

  const hits = []
  const urls = new Set()
  for (const col of cols) {
    const { rows } = await client.query(
      `select "${col.column_name}"::text as v from public."${col.table_name}" where "${col.column_name}"::text like '%res.cloudinary.com%'`,
    )
    if (!rows.length) continue
    const found = new Set(rows.flatMap((r) => r.v.match(URL_RE) ?? []))
    found.forEach((u) => urls.add(u))
    hits.push({ ...col, rows: rows.length, urls: found.size })
    console.log(`${col.table_name}.${col.column_name}: ${rows.length} rows, ${found.size} files`)
  }
  console.log(`\n${urls.size} distinct files to move`)
  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to copy the files and rewrite the database.')
    process.exit(0)
  }

  // 1. Copy every file. Any failure stops here, before the DB is touched.
  const manifest = {}
  let i = 0
  for (const url of urls) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`)
    const key = keyFor(url)
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        Buffer.from(await res.arrayBuffer()),
      ContentType: res.headers.get('content-type') ?? 'application/octet-stream',
    }))
    manifest[url] = `r2://${key}`
    console.log(`[${++i}/${urls.size}] ${key}`)
  }
  const manifestPath = `scripts/cloudinary-to-r2.manifest.${Date.now()}.json`
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`\nmanifest written: ${manifestPath}`)

  // 2. Rewrite every value in one transaction.
  await client.query('BEGIN')
  for (const col of hits) {
    const t = `public."${col.table_name}"`, c = `"${col.column_name}"`
    const isArray = col.udt_name.startsWith('_')
    const isJson  = col.data_type === 'json' || col.data_type === 'jsonb'
    for (const [oldUrl, ref] of Object.entries(manifest)) {
      if (isArray) {
        await client.query(`update ${t} set ${c} = array_replace(${c}, $1, $2) where $1 = any(${c})`, [oldUrl, ref])
      } else if (isJson) {
        await client.query(`update ${t} set ${c} = replace(${c}::text, $1, $2)::${col.data_type} where ${c}::text like '%' || $1 || '%'`, [oldUrl, ref])
      } else {
        await client.query(`update ${t} set ${c} = replace(${c}, $1, $2) where ${c} like '%' || $1 || '%'`, [oldUrl, ref])
      }
    }
  }
  // Nothing may still point at Cloudinary, or the move was incomplete.
  for (const col of hits) {
    const { rows } = await client.query(
      `select count(*)::int n from public."${col.table_name}" where "${col.column_name}"::text like '%res.cloudinary.com%'`,
    )
    if (rows[0].n) throw new Error(`${col.table_name}.${col.column_name} still has ${rows[0].n} Cloudinary values`)
  }
  await client.query('COMMIT')
  console.log('\ndatabase rewritten; no Cloudinary URLs remain')
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error('\nFAILED, database left unchanged:', err.message)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
