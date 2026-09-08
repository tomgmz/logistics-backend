/**
 * Read-only check that the transaction-history module gate does what the
 * permission matrix promises — above all that `can_export` is enforced.
 *
 *   npx tsx scripts/verify-transaction-history-rbac.ts
 *
 * Runs the real middleware against real users from module_permissions with
 * synthetic request objects. Nothing is written, and no HTTP server is needed.
 *
 * This matters because `requiredFlagForMethod` maps every GET to `can_view`:
 * before requireModuleFlag existed, an export route was a GET and the export
 * tier an IT Admin set was silently doing nothing.
 */
import 'dotenv/config'

import type { Request, Response } from 'express'
import { pool } from '../src/lib/database.js'
import { requireModule, requireModuleFlag } from '../src/middlewares/moduleAccess.middleware.js'
import { isProtectedAdmin } from '../src/lib/protected-admin.js'

let checks = 0
let failures = 0

function check(name: string, ok: boolean, detail = '') {
  checks++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

type Outcome = { allowed: boolean; status?: number }

/** Drive one middleware to a verdict with a fake req/res pair. */
function run(
  mw: (req: Request, res: Response, next: () => void) => unknown,
  user: { sub: string; role: string },
  method = 'GET',
): Promise<Outcome> {
  return new Promise((resolve) => {
    const req = { user, method, path: '/', query: {}, params: {}, body: {} } as unknown as Request
    const res = {
      statusCode: 0,
      status(code: number) { this.statusCode = code; return this },
      json() { resolve({ allowed: false, status: this.statusCode }); return this },
    } as unknown as Response
    void (mw as any)(req, res, () => resolve({ allowed: true }))
  })
}

async function main() {
  const readGate   = requireModule('transaction-history')
  const exportGate = requireModuleFlag('transaction-history', 'can_export')

  const { rows } = await pool.query<{
    user_id: string; role: string; can_view: boolean; can_export: boolean
  }>(
    `SELECT u.user_id::text AS user_id, u.role, mp.can_view, mp.can_export
       FROM users u
       JOIN module_permissions mp ON mp.user_id = u.user_id
      WHERE mp.module_name = 'transaction-history'
      ORDER BY mp.can_export, u.role`,
  )

  console.log(`\nTesting ${rows.length} users with a transaction-history permission row\n`)

  for (const u of rows) {
    // The root administrator bypasses every module gate by design, so its
    // verdicts prove nothing about the flag.
    const protectedAdmin = await isProtectedAdmin(u.user_id)
    const label = `${u.role} ${u.user_id.slice(0, 8)} (view=${u.can_view} export=${u.can_export})` +
                  (protectedAdmin ? ' [protected root admin]' : '')
    console.log(label)

    const read = await run(readGate, { sub: u.user_id, role: u.role })
    const exp  = await run(exportGate, { sub: u.user_id, role: u.role })

    if (protectedAdmin) {
      check('  protected admin bypasses both gates', read.allowed && exp.allowed)
      continue
    }

    check('  read gate follows can_view', read.allowed === u.can_view,
      `allowed=${read.allowed} can_view=${u.can_view}${read.status ? ` status=${read.status}` : ''}`)
    check('  export gate follows can_export', exp.allowed === u.can_export,
      `allowed=${exp.allowed} can_export=${u.can_export}${exp.status ? ` status=${exp.status}` : ''}`)

    if (!u.can_export) {
      check('  export refusal is a 403, not a crash', exp.status === 403, `status=${exp.status}`)
      // The regression this whole helper exists to prevent.
      check('  can_view alone does NOT buy export', !(u.can_view && exp.allowed))
    }
    console.log('')
  }

  // A bypass role must never be gated, whatever the matrix says.
  const itAdmin = await pool.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM users WHERE role = 'it_admin' LIMIT 1`,
  )
  if (itAdmin.rows.length > 0) {
    const id = itAdmin.rows[0].user_id
    const r = await run(readGate,   { sub: id, role: 'it_admin' })
    const e = await run(exportGate, { sub: id, role: 'it_admin' })
    check('it_admin bypasses the read gate', r.allowed)
    check('it_admin bypasses the export gate', e.allowed)
  }

  // A non-managed role is left to the route's own authorize() gate, never to
  // the module matrix.
  const client = await run(exportGate, { sub: '00000000-0000-4000-8000-000000000000', role: 'client' })
  check('non-managed role is waved through the module gate', client.allowed,
    'role gates, not module gates, keep clients out of this route')

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${checks - failures}/${checks} checks passed`)
  if (failures > 0) console.log(`${failures} FAILED`)
  console.log('='.repeat(60))

  await pool.end()
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error('\nRBAC VERIFICATION ERROR:', err)
  await pool.end().catch(() => {})
  process.exit(1)
})
