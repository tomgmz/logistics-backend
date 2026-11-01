// Read-only: runs every literal PostgREST select in the backend with limit(1)
// and reports the ones the database refuses. Usage (in logistics-backend): node scripts/check-embeds.mjs .
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve(process.argv[2] ?? '.')
const require = createRequire(path.join(root, 'package.json'))
require('dotenv').config({ path: path.join(root, '.env'), quiet: true })
const { createClient } = require('@supabase/supabase-js')
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)

const files = []
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p) } }
walk(path.join(root, 'src'))

// Named select constants, so `.select(BOOKING_WITH_RELATIONS_SELECT)` resolves.
const consts = {}
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Z_]+SELECT)\s*=\s*`([^`]*)`/g)) consts[m[1]] = m[2]
}

const queries = []
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/\.from\(\s*'([a-z_]+)'\s*\)([\s\S]{0,200}?)\.select\(\s*(`([^`]*)`|'([^']*)'|([A-Z_]+SELECT))/g)) {
    const sel = m[4] ?? m[5] ?? consts[m[6]]
    if (!sel || sel.includes('${') || !sel.includes('(')) continue
    queries.push({ table: m[1], sel: sel.replace(/\s+/g, ' ').trim(), where: path.relative(root, f) })
  }
}

let bad = 0
const seen = new Set()
for (const q of queries) {
  const key = q.table + '|' + q.sel
  if (seen.has(key)) continue
  seen.add(key)
  const { error } = await sb.from(q.table).select(q.sel).limit(1)
  if (error) { bad++; console.log(`FAIL ${q.where} [${q.table}]: ${error.message}`) }
}
console.log(`\nchecked ${seen.size} distinct selects, ${bad} failed`)
