/**
 * Proves the 2026-11-16 change: refresh-token rotation OFF by default, and an
 * older token of a live session accepted (not treated as stolen) while it is
 * off. Also re-checks that reuse detection still works when switched on.
 *
 *   npx tsx scripts/verify-refresh-rotation-off.ts
 *
 * Uses a THROWAWAY account it creates and deletes (no seed accounts needed,
 * no real account touched). The reuse step notifies the IT Administrator; that
 * notice and its log row are deleted at the end.
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { supabase } from '../src/lib/supabase.js'
import * as AuthModel from '../src/models/auth/auth.model.js'
import { issueVerifiedSession, refreshAccessToken } from '../src/services/auth/auth.service.js'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}`) }
  else    { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'no error' } catch (e) { return (e as { code?: string }).code ?? (e as Error).message }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sidOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sid as string
const ageRotation = (sid: string) => supabase.from('active_sessions')
  .update({ refresh_rotated_at: new Date(Date.now() - 2 * 60 * 1000).toISOString() }).eq('id', sid)

const email = `rotation-test-${crypto.randomBytes(4).toString('hex')}@example.invalid`
let userId = ''
const startedAt = new Date().toISOString()

async function signIn() {
  const user = await AuthModel.findUserById(userId)
  return issueVerifiedSession(user as Parameters<typeof issueVerifiedSession>[0], 'verify-refresh-rotation-off')
}

async function main() {
  const { data: created, error: authErr } = await supabase.auth.admin.createUser({
    email, password: crypto.randomBytes(16).toString('hex'), email_confirm: true,
  })
  if (authErr || !created.user) throw authErr ?? new Error('auth user not created')
  userId = created.user.id
  const { error: rowErr } = await supabase.from('users').insert({
    user_id: userId, email, role: 'admin', status: 'active', first_name: 'Rotation', last_name: 'Test',
  })
  if (rowErr) throw rowErr

  console.log('1. Default (ROTATE_REFRESH_TOKENS unset) = rotation off')
  delete process.env.ROTATE_REFRESH_TOKENS
  const s1 = await signIn()
  const off = await refreshAccessToken(s1.refreshToken, { rotate: true })
  check('no new refresh token even when the app asks', !off.refreshToken)
  check('the same token keeps working', !!(await refreshAccessToken(s1.refreshToken, { rotate: true })).accessToken)

  console.log('2. A phone holding an older token after rotation is turned off')
  const s2 = await signIn()
  const r0 = s2.refreshToken
  process.env.ROTATE_REFRESH_TOKENS = 'true'
  const r1 = (await refreshAccessToken(r0, { rotate: true })).refreshToken!
  const r2 = (await refreshAccessToken(r1, { rotate: true })).refreshToken!
  check('(setup) two rotations happened', !!r1 && !!r2 && r2 !== r1)
  await ageRotation(sidOf(r2))
  delete process.env.ROTATE_REFRESH_TOKENS
  // r0 = the sign-in token the old app restores on every start.
  const back = await codeOf(refreshAccessToken(r0, { rotate: true }))
  check('the restored sign-in token is accepted, not called stolen', back === 'no error', back)
  const row = await AuthModel.findSessionForRotation(sidOf(r0))
  check('the session is still live', row?.revoked_reason == null && !!row && new Date(row.refresh_expires_at!).getTime() > Date.now())
  check('the restored token keeps working afterwards', (await codeOf(refreshAccessToken(r0))) === 'no error')
  check('the newest token still works too (same phone, either copy)', (await codeOf(refreshAccessToken(r2))) === 'no error')

  console.log('3. Ended sessions stay ended with rotation off')
  await AuthModel.revokeAllUserSessions(userId, 'logout')
  const ended = await codeOf(refreshAccessToken(r0))
  check('a signed-out session is refused (not revived)', ended !== 'no error' && ended !== 'SESSION_REUSED', ended)

  console.log('4. Reuse detection still works when switched on')
  const s4 = await signIn()
  process.env.ROTATE_REFRESH_TOKENS = 'true'
  const q1 = (await refreshAccessToken(s4.refreshToken, { rotate: true })).refreshToken!
  await refreshAccessToken(q1, { rotate: true })
  await ageRotation(sidOf(q1))
  check('a retired token is refused as reuse', (await codeOf(refreshAccessToken(s4.refreshToken, { rotate: true }))) === 'SESSION_REUSED')
  delete process.env.ROTATE_REFRESH_TOKENS
  await sleep(4000) // the notice and log are written in the background
}

async function cleanup() {
  if (!userId) return
  await AuthModel.revokeAllUserSessions(userId, 'logout').catch(() => {})
  const n = await supabase.from('notifications').delete()
    .eq('type', 'auth.session_reuse').eq('data->>account', email).select('notification_id')
  const l = await supabase.from('system_logs').delete()
    .eq('metadata->>subject', userId).gte('timestamp', startedAt).select('id')
  const s = await supabase.from('active_sessions').delete().eq('user_id', userId).select('id')
  await supabase.from('users').delete().eq('user_id', userId)
  const { error } = await supabase.auth.admin.deleteUser(userId)
  console.log(`Cleanup: ${n.data?.length ?? 0} notice(s), ${l.data?.length ?? 0} log row(s), ${s.data?.length ?? 0} session(s), test account ${error ? `NOT deleted: ${error.message}` : 'deleted'}`)
}

main()
  .catch((e) => { failed++; console.error(e) })
  .finally(async () => {
    await cleanup()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
  })
