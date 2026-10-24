/**
 * Proves the two-step IT Administrator handover (2026-10-25) at the database:
 *
 *   npx tsx scripts/verify-it-admin-transition.ts
 *
 * start_it_admin_handover → add_it_admin_successor → complete_it_admin_handover,
 * and the rule the whole feature protects: there is never a moment with no
 * ACTIVE IT Admin (every password reset routes to the it_admin queue).
 *
 * Everything runs inside BEGIN/ROLLBACK on a raw pg connection against the REAL
 * current IT Admin, so nothing survives. users.user_id is FK'd to auth.users, so
 * the successor's identity is inserted into auth.users inside the same
 * transaction and rolled back with it.
 *
 * Deliberately NOT covered: the service steps that create a Supabase Auth user,
 * email a real temporary password, or archive (ban) a real login. Those cannot
 * be rolled back; their database halves are what is asserted here.
 */
import 'dotenv/config'
import crypto from 'crypto'
import { pool } from '../src/lib/database.js'

let passed = 0
let failed = 0
const ok    = (m: string) => { passed++; console.log(`  PASS  ${m}`) }
const bad   = (m: string) => { failed++; console.log(`  FAIL  ${m}`) }
const check = (m: string, cond: boolean, detail = '') => (cond ? ok(m) : bad(`${m}${detail ? ` — ${detail}` : ''}`))

const client = await pool.connect()
const activeCount = async () =>
  Number((await client.query(`select count(*)::int n from users where role='it_admin' and status='active'`)).rows[0].n)

/** Run `sql` expecting it to raise `token`; isolated in a savepoint. */
async function expectRaise(label: string, token: string, sql: string, params: unknown[]) {
  await client.query('SAVEPOINT x')
  try {
    await client.query(sql, params)
    bad(`${label} — expected ${token}, got success`)
  } catch (err: any) {
    check(label, String(err?.message).includes(token), err?.message)
  }
  await client.query('ROLLBACK TO SAVEPOINT x')
}

try {
  await client.query('BEGIN')

  const { rows: seat } = await client.query(
    `select user_id, email from users where role='it_admin' and status='active' and render_ends_at is null`,
  )
  check('exactly one seat holder before', seat.length === 1, `found ${seat.length}`)
  const outgoing = seat[0]
  const before = await activeCount()

  // Step 1: start.
  const { rows: [h] } = await client.query(`select * from start_it_admin_handover($1, $2, 30)`, [
    outgoing.user_id, 'verify script: handover rehearsal',
  ])
  check('start returns an open handover', !!h?.handover_id && !h.ended_at && !h.successor_id)
  const { rows: [o1] } = await client.query(`select status, render_ends_at from users where user_id=$1`, [outgoing.user_id])
  check('outgoing still active, now rendering', o1.status === 'active' && !!o1.render_ends_at)
  check('render target is ~30 days out',
    Math.abs(new Date(h.render_due_at).getTime() - Date.now() - 30 * 86_400_000) < 3_600_000)
  check('active IT Admin count unchanged after start', (await activeCount()) === before)

  await expectRaise('a second start is refused', 'NOT_SEAT_HOLDER',
    `select * from start_it_admin_handover($1, 'again', 30)`, [outgoing.user_id])

  // Step 2: successor.
  const incoming = crypto.randomUUID()
  const email = `verify-successor-${incoming.slice(0, 8)}@example.com`
  await client.query('insert into auth.users (id, email) values ($1, $2)', [incoming, email])
  const { rows: [succ] } = await client.query(
    `select * from add_it_admin_successor($1, $2, $3, 'Verify', 'Successor', null, null, null)`,
    [outgoing.user_id, incoming, email],
  )
  check('successor created active, must change password',
    succ.status === 'active' && succ.must_change_password === true && succ.role === 'it_admin')
  check('successor password expiry stamped', !!succ.temp_password_expires_at)
  check('two active IT Admins while pending (never zero)', (await activeCount()) === before + 1)

  const other = crypto.randomUUID()
  await client.query('insert into auth.users (id, email) values ($1, $2)', [other, `verify-other-${other.slice(0, 8)}@example.com`])
  await expectRaise('a second successor is refused while one is pending', 'SUCCESSOR_PENDING',
    `select * from add_it_admin_successor($1, $2, 'x@example.com', 'X', 'Y', null, null, null)`, [outgoing.user_id, other])

  // Step 3: confirmation.
  const { rows: [{ complete_it_admin_handover: done }] } = await client.query(
    `select complete_it_admin_handover($1)`, [incoming],
  )
  check('completion returns the outgoing id', done === outgoing.user_id)
  const { rows: [closed] } = await client.query(`select confirmed_at, ended_at from it_admin_handovers where handover_id=$1`, [h.handover_id])
  check('handover marked confirmed and ended', !!closed.confirmed_at && !!closed.ended_at)
  const { rows: [{ complete_it_admin_handover: again }] } = await client.query(
    `select complete_it_admin_handover($1)`, [incoming],
  )
  check('completing twice is a no-op', again === null)

  // The service archives the outgoing account next; its database half:
  await client.query(`update users set status='archived' where user_id=$1`, [outgoing.user_id])
  check('after archive exactly one active IT Admin, the successor', (await activeCount()) === before)

  // Cancel path, on a fresh handover by the successor (now the seat holder).
  await client.query(`update users set must_change_password=false where user_id=$1`, [incoming])
  const { rows: [h2] } = await client.query(`select * from start_it_admin_handover($1, 'verify cancel path', 30)`, [incoming])
  check('the new IT Admin can start their own handover', !!h2?.handover_id)
} catch (err) {
  bad(`unexpected error: ${(err as Error).message}`)
} finally {
  await client.query('ROLLBACK').catch(() => {})
  client.release()
  await pool.end()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
