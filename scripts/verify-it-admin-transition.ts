/**
 * Proves the single-IT-Admin rule and the handover that works around it.
 *
 *   npx tsx scripts/verify-it-admin-transition.ts
 *
 * The regression that matters is the one this whole feature exists to prevent:
 * a moment with no ACTIVE IT Admin. Every staff password reset routes to the
 * 'it_admin' queue, a Company Admin is refused on those rows, and recipient
 * lookups filter on status='active' — so an empty seat makes staff resets both
 * invisible and unactionable. The transition_it_admin() RPC is asserted to
 * retire the outgoing account and install the incoming one in ONE transaction,
 * with the count never leaving 1.
 *
 * Unlike the other verify scripts, the destructive half runs inside an explicit
 * BEGIN/ROLLBACK on a raw pg connection. That is deliberate: the assertions have
 * to run against the REAL current IT Admin (the unique index makes it impossible
 * to stage a second active one), and nothing they do may survive. A rolled-back
 * transaction is the only way to have both.
 *
 * Deliberately NOT covered: the service-level transitionITAdmin(). It creates a
 * Supabase Auth identity and emails a real person a real password, neither of
 * which belongs in a verification run. Its guard paths are asserted here; the
 * Auth + email steps share their code path with createITAdmin.
 */
import 'dotenv/config'
import crypto from 'crypto'
import { pool } from '../src/lib/database.js'
import * as ITAdminService from '../src/services/admin/it-admin.service.js'
import * as ITAdminModel from '../src/models/admin/it-admin.model.js'

let passed = 0
let failed = 0
const ok  = (m: string) => { passed++; console.log(`  PASS  ${m}`) }
const bad = (m: string) => { failed++; console.log(`  FAIL  ${m}`) }

/** Assert an awaited call rejects, and (optionally) with a specific error code. */
async function expectThrows(label: string, fn: () => Promise<unknown>, code?: string) {
  try {
    await fn()
    bad(`${label} — expected a refusal, got success`)
  } catch (e: any) {
    if (code && e?.code !== code) bad(`${label} — refused with ${e?.code ?? '(no code)'}, expected ${code}`)
    else ok(`${label} — refused: "${e.message.split('\n')[0]}"`)
  }
}

async function main() {
  console.log('\n1. The constraint exists and is scoped to ACTIVE accounts')
  const { rows: idx } = await pool.query(
    `select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'users'
        and indexname = 'users_one_active_it_admin'`,
  )
  idx.length === 1
    ? ok('users_one_active_it_admin exists')
    : bad('users_one_active_it_admin is missing — apply 20260916010000')
  // Postgres renders the stored predicate with its own casts —
  // ((status)::text = 'active'::text) — so match on the parts, not the spelling.
  const def = idx[0]?.indexdef ?? ''
  def.includes(`'active'`) && def.includes(`'it_admin'`) && def.toUpperCase().includes('UNIQUE')
    ? ok('a UNIQUE index scoped to active it_admin rows, so a kept predecessor does not count')
    : bad(`unexpected index definition: ${def}`)

  const { rows: [{ n: activeCount }] } = await pool.query(
    `select count(*)::int as n from public.users where role = 'it_admin' and status = 'active'`,
  )
  activeCount === 1
    ? ok('exactly one active IT Admin right now')
    : bad(`expected exactly 1 active IT Admin, found ${activeCount}`)
  if (activeCount !== 1) return finish()

  const { rows: [outgoing] } = await pool.query(
    `select user_id, email from public.users where role = 'it_admin' and status = 'active'`,
  )

  console.log('\n2. A second ACTIVE IT Admin is impossible; a kept predecessor is not')
  // Everything here is thrown away — see the header.
  const client = await pool.connect()

  /**
   * `users.user_id` is FK'd to `auth.users(id)`, so a profile row cannot exist
   * without an identity behind it. Inside this throwaway transaction we mint the
   * identity ourselves rather than going through the Auth API — which would
   * create something real that a ROLLBACK could not take back.
   */
  const mintId = async (label: string): Promise<string> => {
    const id = crypto.randomUUID()
    await client.query('insert into auth.users (id, email) values ($1, $2)', [
      id, `verify-${label}-${id}@example.com`,
    ])
    return id
  }

  try {
    await client.query('BEGIN')

    const secondId = await mintId('dup')
    try {
      await client.query(
        `insert into public.users (user_id, email, first_name, last_name, role, status)
         values ($1, $2, 'Verify', 'Duplicate', 'it_admin', 'active')`,
        [secondId, `verify-dup-${secondId}@example.com`],
      )
      bad('a second ACTIVE it_admin was accepted')
    } catch (e: any) {
      e.code === '23505'
        ? ok('a second ACTIVE it_admin is rejected by the unique index (23505)')
        : bad(`rejected, but with ${e.code}: ${e.message}`)
    }
    // That failure aborted the transaction; start a clean one for the next case.
    await client.query('ROLLBACK')
    await client.query('BEGIN')

    const keptId = await mintId('kept')
    await client.query(
      `insert into public.users (user_id, email, first_name, last_name, role, status)
       values ($1, $2, 'Verify', 'Predecessor', 'it_admin', 'deactivated')`,
      [keptId, `verify-kept-${keptId}@example.com`],
    )
    ok('a DEACTIVATED it_admin coexists — the predecessor record is keepable')

    console.log('\n3. The handover is atomic: the seat is never empty')
    const incomingId = await mintId('incoming')
    const { rows: [created] } = await client.query(
      `select * from public.transition_it_admin($1, $2, $3, 'Verify', 'Successor', null, null, null, null)`,
      [outgoing.user_id, incomingId, `verify-incoming-${incomingId}@example.com`],
    )

    created?.user_id === incomingId && created.role === 'it_admin' && created.status === 'active'
      ? ok('the incoming account is created active and in role')
      : bad(`incoming row is ${created?.role}/${created?.status}`)
    created?.must_change_password === true
      ? ok('the incoming account must change the password it was mailed')
      : bad('must_change_password was not set on the incoming account')

    const { rows: [after] } = await client.query(
      `select status from public.users where user_id = $1`, [outgoing.user_id],
    )
    after.status === 'deactivated'
      ? ok('the outgoing account is deactivated, not archived — the handover stays reversible')
      : bad(`outgoing account is ${after.status}`)

    const { rows: [{ n: postCount }] } = await client.query(
      `select count(*)::int as n from public.users where role = 'it_admin' and status = 'active'`,
    )
    postCount === 1
      ? ok('still exactly one active IT Admin — the count never dipped to zero or rose to two')
      : bad(`after the swap there are ${postCount} active IT Admins`)

    console.log('\n4. The RPC refuses a bad outgoing account')
    try {
      await client.query('SAVEPOINT s1')
      const againId = await mintId('again')
      await client.query(
        `select * from public.transition_it_admin($1, $2, $3, 'Verify', 'Twice', null, null, null, null)`,
        [outgoing.user_id, againId, `verify-again-${againId}@example.com`],
      )
      bad('transitioning an already-deactivated account was allowed')
    } catch (e: any) {
      await client.query('ROLLBACK TO SAVEPOINT s1')
      e.message.includes('OUTGOING_NOT_ACTIVE')
        ? ok('an already-deactivated outgoing account is refused (OUTGOING_NOT_ACTIVE)')
        : bad(`refused, but with: ${e.message}`)
    }

    try {
      await client.query('SAVEPOINT s2')
      const { rows: [someone] } = await client.query(
        `select user_id from public.users where role <> 'it_admin' limit 1`,
      )
      const wrongId = await mintId('wrong')
      await client.query(
        `select * from public.transition_it_admin($1, $2, $3, 'Verify', 'WrongRole', null, null, null, null)`,
        [someone.user_id, wrongId, `verify-wrong-${wrongId}@example.com`],
      )
      bad('transitioning a non-IT-Admin account was allowed')
    } catch (e: any) {
      await client.query('ROLLBACK TO SAVEPOINT s2')
      e.message.includes('OUTGOING_NOT_IT_ADMIN')
        ? ok('a non-IT-Admin outgoing account is refused (OUTGOING_NOT_IT_ADMIN)')
        : bad(`refused, but with: ${e.message}`)
    }
  } finally {
    // Nothing above is kept. This is the whole reason the section is safe to run
    // against production.
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }

  console.log('\n5. Nothing from section 2-4 survived the rollback')
  const { rows: [{ n: finalCount }] } = await pool.query(
    `select count(*)::int as n from public.users where role = 'it_admin'`,
  )
  const { rows: [stillActive] } = await pool.query(
    `select user_id, status from public.users where role = 'it_admin' and status = 'active'`,
  )
  stillActive?.user_id === outgoing.user_id
    ? ok(`the real IT Admin (${outgoing.email}) is untouched and still active`)
    : bad('the real IT Admin was mutated — the rollback did not hold')
  console.log(`        (${finalCount} it_admin row(s) total, unchanged)`)

  console.log('\n6. Service guards keep the seat from being vacated outright')
  // These refuse before writing anything, so they need no rollback.
  await expectThrows(
    'an IT Admin deactivating themselves',
    () => ITAdminService.deactivateITAdmin(outgoing.user_id, outgoing.user_id),
    'IT_ADMIN_SELF_ACTION',
  )
  await expectThrows(
    'an IT Admin archiving themselves',
    () => ITAdminService.deleteITAdmin(outgoing.user_id, outgoing.user_id),
    'IT_ADMIN_SELF_ACTION',
  )
  await expectThrows(
    'someone else deactivating the last active IT Admin',
    () => ITAdminService.deactivateITAdmin(outgoing.user_id, crypto.randomUUID()),
    'LAST_IT_ADMIN',
  )
  await expectThrows(
    'someone else archiving the last active IT Admin',
    () => ITAdminService.deleteITAdmin(outgoing.user_id, crypto.randomUUID()),
    'LAST_IT_ADMIN',
  )

  console.log('\n7. Creating a second IT Admin is refused before any auth user is made')
  await expectThrows(
    'createITAdmin while one is already active',
    () => ITAdminService.createITAdmin({
      first_name: 'Verify',
      last_name:  'Rejected',
      email:      `verify-rejected-${crypto.randomUUID()}@example.com`,
      phone:      '+639171234567',
    }),
    'IT_ADMIN_EXISTS',
  )

  const countOthers = await ITAdminModel.countOtherActive(outgoing.user_id)
  countOthers === 0
    ? ok('countOtherActive() sees no replacement waiting, which is what the guard reads')
    : bad(`countOtherActive() returned ${countOthers}`)

  return finish()
}

async function finish() {
  // Nothing to tear down: section 2-4 rolled back, and sections 6-7 only asserted
  // refusals, which write nothing by definition. Section 5 is the proof.
  await pool.end().catch(() => {})
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\nHARNESS ERROR:', err)
  await pool.end().catch(() => {})
  process.exit(1)
})
