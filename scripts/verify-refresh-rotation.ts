/**
 * Proves refresh-token rotation (2026-11-14) against the real database.
 *
 *   npx tsx scripts/verify-refresh-rotation.ts
 *
 * Signs in a SEED driver (never a real account), then: no rotation without the
 * flag, rotation with it, the same new token for a repeat inside the grace
 * period, two refreshes at once, reuse after the grace period ending every
 * session, sign-in elsewhere still reading as SESSION_REPLACED, and the kill
 * switch. The reuse step sends a real "Account signed out for safety" notice to
 * the IT Administrator and writes a System Logs row; both are deleted at the
 * end, and the seed driver is left signed out.
 */
import 'dotenv/config'
import { supabase } from '../src/lib/supabase.js'
import * as AuthModel from '../src/models/auth/auth.model.js'
import { issueVerifiedSession, refreshAccessToken } from '../src/services/auth/auth.service.js'

const SEED_EMAIL = '8338logisticsservice+seed.driver050@gmail.com'

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

async function signIn(userId: string) {
  const user = await AuthModel.findUserById(userId)
  if (!user) throw new Error('seed user not found')
  return issueVerifiedSession(user as Parameters<typeof issueVerifiedSession>[0], 'verify-refresh-rotation')
}

async function sessionRow(refreshToken: string) {
  const [, b64] = refreshToken.split('.')
  const sid = JSON.parse(Buffer.from(b64, 'base64url').toString()).sid as string
  return AuthModel.findSessionForRotation(sid)
}

async function main() {
  const { data: seed } = await supabase.from('users').select('user_id, email').eq('email', SEED_EMAIL).single()
  if (!seed) throw new Error(`seed account ${SEED_EMAIL} missing`)
  const userId = seed.user_id as string
  const startedAt = new Date().toISOString()

  console.log('1. Without the rotate flag (older app builds)')
  const s1 = await signIn(userId)
  const r0 = s1.refreshToken
  const plain = await refreshAccessToken(r0)
  check('no new refresh token is handed out', !plain.refreshToken)
  check('the same refresh token still works', !!(await refreshAccessToken(r0)).accessToken)

  console.log('2. With the rotate flag')
  const row0 = await sessionRow(r0)
  const rot1 = await refreshAccessToken(r0, { rotate: true })
  check('a new refresh token is handed out', !!rot1.refreshToken && rot1.refreshToken !== r0)
  check('the session end date is unchanged',
    !!row0?.refresh_expires_at && rot1.refreshExpiresAt === new Date(row0.refresh_expires_at).toISOString(),
    `${rot1.refreshExpiresAt} vs ${row0?.refresh_expires_at}`)
  const r1 = rot1.refreshToken!

  console.log('3. Repeat of the retired token inside the grace period (lost reply)')
  const again = await refreshAccessToken(r0, { rotate: true })
  check('gets the SAME new token back', again.refreshToken === r1)
  check('the session is still live', (await sessionRow(r1))?.revoked_reason == null)

  console.log('4. Two refreshes of the same token at once (two tabs)')
  const [a, b] = await Promise.all([
    refreshAccessToken(r1, { rotate: true }),
    refreshAccessToken(r1, { rotate: true }),
  ])
  check('both get the same new token', !!a.refreshToken && a.refreshToken === b.refreshToken)
  const r2 = a.refreshToken!
  const rot3 = await refreshAccessToken(r2, { rotate: true })
  check('the new token rotates normally', !!rot3.refreshToken && rot3.refreshToken !== r2)
  const r3 = rot3.refreshToken!

  console.log('5. Reuse after the grace period')
  const sid = (await sessionRow(r3))!.id
  await supabase.from('active_sessions')
    .update({ refresh_rotated_at: new Date(Date.now() - 2 * 60 * 1000).toISOString() })
    .eq('id', sid)
  check('the retired token is refused as reuse', (await codeOf(refreshAccessToken(r2, { rotate: true }))) === 'SESSION_REUSED')
  check('the session is ended with reason refresh_reuse', (await AuthModel.findSessionForRotation(sid))?.revoked_reason === 'refresh_reuse')
  check('the CURRENT token is refused too', (await codeOf(refreshAccessToken(r3, { rotate: true }))) === 'SESSION_REUSED')
  await sleep(4000) // the notice and log are written in the background

  const { data: notices } = await supabase.from('notifications')
    .select('notification_id').eq('type', 'auth.session_reuse').gte('created_at', startedAt)
  check('the IT Administrator was notified', (notices?.length ?? 0) > 0)

  console.log('6. Signed in elsewhere after a rotation')
  const s2 = await signIn(userId)
  const q1 = (await refreshAccessToken(s2.refreshToken, { rotate: true })).refreshToken!
  await signIn(userId) // the "other device"
  check('the current token reads SESSION_REPLACED', (await codeOf(refreshAccessToken(q1, { rotate: true }))) === 'SESSION_REPLACED')
  check('a retired token reads SESSION_REPLACED, not reuse', (await codeOf(refreshAccessToken(s2.refreshToken, { rotate: true }))) === 'SESSION_REPLACED')

  console.log('7. Kill switch ROTATE_REFRESH_TOKENS=false')
  const s3 = await signIn(userId)
  process.env.ROTATE_REFRESH_TOKENS = 'false'
  const off = await refreshAccessToken(s3.refreshToken, { rotate: true })
  check('no rotation while switched off', !off.refreshToken)
  delete process.env.ROTATE_REFRESH_TOKENS
  check('rotation resumes when switched back on', !!(await refreshAccessToken(s3.refreshToken, { rotate: true })).refreshToken)

  console.log('Cleanup')
  await AuthModel.revokeAllUserSessions(userId, 'logout')
  const delN = await supabase.from('notifications').delete()
    .eq('type', 'auth.session_reuse').gte('created_at', startedAt).select('notification_id')
  const delL = await supabase.from('system_logs').delete()
    .eq('source', 'auth.service').gte('timestamp', startedAt)
    .eq('metadata->>subject', userId).select('id')
  console.log(`  removed ${delN.data?.length ?? 0} notice(s), ${delL.data?.length ?? 0} log row(s); seed driver signed out`)
  if (delN.error) console.log('  notice cleanup error:', delN.error.message)
  if (delL.error) console.log('  log cleanup error:', delL.error.message)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
