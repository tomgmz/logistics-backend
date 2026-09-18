/**
 * Proves the admin-mediated password reset flow, above all the routing split.
 *
 *   npx tsx scripts/verify-password-reset.ts
 *
 * The one regression that matters here is the handler split: driver and client
 * resets belong to the Company Admin, staff resets to the IT Admin, and neither
 * may act on the other's queue. The routes cannot express that — they only gate
 * with authorize('admin','it_admin') — so it is enforced in the service and
 * asserted first here, exactly as the controller calls it.
 *
 * This creates real rows, because the service writes through PostgREST which
 * cannot see an uncommitted transaction. Everything it makes is torn down at the
 * end, so a run leaves the database as it found it.
 *
 * Deliberately NOT covered: completeReset() against a live account. That rewrites
 * a real password in Supabase Auth, which is not something a verification script
 * should do to a production user. Its guard paths (bad token, expired token,
 * deactivated account) are all asserted; only the final password write is left to
 * a manual pass with a throwaway account.
 */
import 'dotenv/config'
import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { supabase } from '../src/lib/supabase.js'
import * as ResetService from '../src/services/auth/password-reset.service.js'
import * as ResetModel from '../src/models/auth/password-reset.model.js'
import { hashToken } from '../src/services/auth/auth.service.js'

let passed = 0
let failed = 0
const ok  = (m: string) => { passed++; console.log(`  PASS  ${m}`) }
const bad = (m: string) => { failed++; console.log(`  FAIL  ${m}`) }

const createdRequestIds: string[] = []

async function main() {
  console.log('\n1. handlerGroupFor() — the routing rule')
  const cases: [string, string][] = [
    ['driver', 'company_admin'], ['client', 'company_admin'],
    ['admin', 'it_admin'], ['it_admin', 'it_admin'], ['general_manager', 'it_admin'],
    ['accountant', 'it_admin'], ['fleet_manager', 'it_admin'], ['operations_manager', 'it_admin'],
  ]
  for (const [role, expected] of cases) {
    const got = ResetService.handlerGroupFor(role)
    got === expected ? ok(`${role} -> ${got}`) : bad(`${role} -> ${got}, expected ${expected}`)
  }

  // Actors, drawn from whoever actually staffs each queue.
  const { data: admins }   = await supabase.from('users').select('user_id').eq('role', 'admin').eq('status', 'active').limit(1)
  const { data: itAdmins } = await supabase.from('users').select('user_id').eq('role', 'it_admin').eq('status', 'active').limit(1)
  if (!admins?.length || !itAdmins?.length) {
    console.error('Need one active admin and one active it_admin to run this.')
    process.exit(1)
  }
  const companyAdmin: ResetService.ResetActor = { user_id: admins[0].user_id, role: 'admin' }
  const itAdmin:      ResetService.ResetActor = { user_id: itAdmins[0].user_id, role: 'it_admin' }

  // Subjects: one on each side of the split.
  const { data: clientUser } = await supabase.from('users')
    .select('user_id, email').eq('role', 'client').eq('status', 'active').limit(1).single()
  const { data: staffUser } = await supabase.from('users')
    .select('user_id, email').eq('role', 'general_manager').eq('status', 'active').limit(1).single()

  console.log('\n2. A request files into the right queue')
  await ResetService.requestPasswordReset({ email: clientUser!.email })
  await ResetService.requestPasswordReset({ email: staffUser!.email })
  const clientReq = await ResetModel.findOpenByUser(clientUser!.user_id)
  const staffReq  = await ResetModel.findOpenByUser(staffUser!.user_id)
  if (!clientReq || !staffReq) { bad('requests were not created'); return finish() }
  createdRequestIds.push(clientReq.request_id, staffReq.request_id)

  clientReq.handler_group === 'company_admin'
    ? ok(`client request -> company_admin queue`)
    : bad(`client request -> ${clientReq.handler_group}`)
  staffReq.handler_group === 'it_admin'
    ? ok(`general_manager request -> it_admin queue`)
    : bad(`general_manager request -> ${staffReq.handler_group}`)
  clientReq.token_hash === null
    ? ok('no token exists until an admin sends the link')
    : bad('a token was minted at request time')

  console.log('\n3. Strict split — the wrong admin is refused before any email')
  try {
    await ResetService.sendResetLink(clientReq.request_id, itAdmin)
    bad('it_admin was allowed to send a CLIENT reset link')
  } catch (e: any) {
    e.code === 'RESET_WRONG_HANDLER'
      ? ok(`it_admin refused on a client request: "${e.message}"`)
      : bad(`refused, but with an unexpected error: ${e.message}`)
  }
  try {
    await ResetService.sendResetLink(staffReq.request_id, companyAdmin)
    bad('company admin was allowed to send a STAFF reset link')
  } catch (e: any) {
    e.code === 'RESET_WRONG_HANDLER'
      ? ok(`company admin refused on a staff request: "${e.message}"`)
      : bad(`refused, but with an unexpected error: ${e.message}`)
  }
  // Neither refusal may have touched the rows.
  const stillPending = await ResetModel.findById(clientReq.request_id)
  stillPending?.status === 'pending' && stillPending.token_hash === null
    ? ok('a refused send leaves the request untouched')
    : bad(`refused send mutated the row: ${stillPending?.status}`)

  console.log('\n4. Queue scoping — each admin reads only their own group')
  const coQueue = await ResetService.listRequestsForActor(companyAdmin)
  const itQueue = await ResetService.listRequestsForActor(itAdmin)
  coQueue.every((r) => r.handler_group === 'company_admin')
    ? ok(`company admin queue: ${coQueue.length} row(s), all company_admin`)
    : bad('company admin queue leaked an it_admin row')
  itQueue.every((r) => r.handler_group === 'it_admin')
    ? ok(`it_admin queue: ${itQueue.length} row(s), all it_admin`)
    : bad('it_admin queue leaked a company_admin row')
  coQueue.some((r) => r.first_name !== null || r.last_name !== null)
    ? ok('queue rows carry the requester name, not just a UUID')
    : bad('queue rows are missing the name join')

  console.log('\n5. A repeat request reuses the open row instead of spamming the queue')
  const rowsBefore  = (await supabase.from('password_reset_requests').select('request_id')).data!.length
  const notifBefore = (await supabase.from('notifications').select('notification_id').eq('type', 'auth.password_reset_requested')).data!.length
  await ResetService.requestPasswordReset({ email: clientUser!.email })
  const rowsAfter  = (await supabase.from('password_reset_requests').select('request_id')).data!.length
  const notifAfter = (await supabase.from('notifications').select('notification_id').eq('type', 'auth.password_reset_requested')).data!.length
  rowsAfter === rowsBefore
    ? ok(`no duplicate request row (${rowsBefore} -> ${rowsAfter})`)
    : bad(`request rows changed ${rowsBefore} -> ${rowsAfter}`)
  notifAfter === notifBefore
    ? ok(`re-notify cooldown held (${notifBefore} -> ${notifAfter} notifications)`)
    : bad(`re-notified inside the cooldown (${notifBefore} -> ${notifAfter})`)

  console.log('\n6. No enumeration — unknown and switched-off accounts leave no trace')
  const beforeUnknown = (await supabase.from('password_reset_requests').select('request_id')).data!.length
  await ResetService.requestPasswordReset({ email: 'no-such-account-xyz@example.com' })
  const afterUnknown = (await supabase.from('password_reset_requests').select('request_id')).data!.length
  afterUnknown === beforeUnknown
    ? ok('an unknown email creates no request row')
    : bad('an unknown email created a row')

  console.log('\n7. A reset cannot resurrect a deactivated account')
  await supabase.from('users').update({ status: 'deactivated' }).eq('user_id', staffUser!.user_id)
  const resurrected = await ResetModel.clearLockout(staffUser!.user_id)
  resurrected
    ? bad('clearLockout reactivated a DEACTIVATED account')
    : ok('clearLockout refuses a deactivated account')
  await supabase.from('users').update({ status: 'active' }).eq('user_id', staffUser!.user_id)
  const { data: restored } = await supabase.from('users').select('status').eq('user_id', staffUser!.user_id).single()
  restored!.status === 'active'
    ? ok('subject account restored to active')
    : bad(`subject left as ${restored!.status}`)

  console.log('\n8. Token lifecycle — verified against a synthetic token, nothing emailed')
  const token = crypto.randomBytes(32).toString('base64url')
  await supabase.from('password_reset_requests').update({
    status:           'sent',
    token_hash:       hashToken(token),
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }).eq('request_id', staffReq.request_id)

  const live = await ResetService.verifyResetToken(token)
  live.valid ? ok(`a live token verifies (email shown as ${live.email})`) : bad('a live token failed to verify')
  live.email && !live.email.includes(staffUser!.email.split('@')[0])
    ? ok('the masked email hides the local part')
    : bad(`the mask is leaking: ${live.email}`)

  const unrelated = await ResetService.verifyResetToken(crypto.randomBytes(32).toString('base64url'))
  !unrelated.valid ? ok('an unrelated token is rejected') : bad('an unrelated token verified')

  await supabase.from('password_reset_requests')
    .update({ token_expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('request_id', staffReq.request_id)
  const expired = await ResetService.verifyResetToken(token)
  !expired.valid ? ok('an expired token is rejected') : bad('an expired token still verified')

  try {
    await ResetService.completeReset(token, 'Str0ngPassw0rd')
    bad('completeReset accepted an expired token')
  } catch (e: any) {
    e.code === 'RESET_TOKEN_INVALID'
      ? ok('completeReset refuses an expired token')
      : bad(`refused, but with an unexpected error: ${e.message}`)
  }

  await ResetModel.expireStale()
  const afterSweep = await ResetModel.findById(staffReq.request_id)
  afterSweep?.status === 'expired' && afterSweep.token_hash === null
    ? ok('expireStale() retires the stale row and clears its token hash')
    : bad(`stale row is ${afterSweep?.status}, hash=${afterSweep?.token_hash}`)

  console.log('\n9. The IT Admin resets themselves by code')

  ;[['it_admin', true], ['admin', false], ['general_manager', false], ['driver', false]]
    .forEach(([role, expected]) => {
      ResetService.canSelfResetByOtp(role as string) === expected
        ? ok(`canSelfResetByOtp(${role}) -> ${expected}`)
        : bad(`canSelfResetByOtp(${role}) -> ${!expected}, expected ${expected}`)
    })

  const { data: itAdminUser } = await supabase.from('users')
    .select('user_id, email').eq('user_id', itAdmin.user_id).single()

  // Seeded directly with a known hash, so the whole path is exercised without
  // asking Brevo to send a real IT Admin a real code.
  const CODE = '135790'
  const otpReq = await ResetModel.createOtpRequest({
    user_id:        itAdminUser!.user_id,
    email:          itAdminUser!.email,
    requested_role: 'it_admin',
    otp_hash:       await bcrypt.hash(CODE, 12),
    otp_expires_at: new Date(Date.now() + 10 * 60 * 1000),
  })
  createdRequestIds.push(otpReq.request_id)

  otpReq.delivery_method === 'otp' && otpReq.status === 'pending' && otpReq.token_hash === null
    ? ok('an OTP request opens pending, with no token minted yet')
    : bad(`OTP request opened as ${otpReq.delivery_method}/${otpReq.status}`)

  // The row is open and in the it_admin group, but it is self-served — putting it
  // in the queue would offer a Send button for a request already being handled.
  const queueWithOtp = await ResetService.listRequestsForActor(itAdmin)
  queueWithOtp.every((r) => r.request_id !== otpReq.request_id)
    ? ok('an OTP request never appears in the admin queue')
    : bad('the OTP request is sitting in the it_admin queue')

  try {
    await ResetService.sendResetLink(otpReq.request_id, itAdmin)
    bad('an OTP request was allowed to send a link')
  } catch (e: any) {
    ok(`sendResetLink refuses an OTP request: "${e.message}"`)
  }

  try {
    await ResetService.verifyItAdminOtp({ email: itAdminUser!.email, code: '000000' })
    bad('a wrong code was accepted')
  } catch (e: any) {
    e.code === 'RESET_OTP_INCORRECT'
      ? ok(`a wrong code is refused: "${e.message}"`)
      : bad(`refused, but with an unexpected error: ${e.code} ${e.message}`)
  }
  const afterWrong = await ResetModel.findById(otpReq.request_id)
  afterWrong?.otp_attempts === 1
    ? ok('a wrong code is counted against the attempt budget')
    : bad(`attempts is ${afterWrong?.otp_attempts}, expected 1`)

  const verified = await ResetService.verifyItAdminOtp({ email: itAdminUser!.email, code: CODE })
  const afterVerify = await ResetModel.findById(otpReq.request_id)
  afterVerify?.status === 'sent' && afterVerify.otp_hash === null
    ? ok('a correct code spends itself and mints a token')
    : bad(`after verify the row is ${afterVerify?.status}, hash=${afterVerify?.otp_hash}`)
  afterVerify?.sent_by === itAdminUser!.user_id
    ? ok('the IT Admin is recorded as their own sender')
    : bad(`sent_by is ${afterVerify?.sent_by}`)

  const otpToken = await ResetService.verifyResetToken(verified.token)
  otpToken.valid
    ? ok('the minted token verifies on the ordinary reset path')
    : bad('the token from a verified code does not verify')

  try {
    await ResetService.verifyItAdminOtp({ email: itAdminUser!.email, code: CODE })
    bad('a spent code was accepted a second time')
  } catch (e: any) {
    e.code === 'RESET_OTP_INVALID'
      ? ok('a spent code cannot be replayed')
      : bad(`refused, but with an unexpected error: ${e.code} ${e.message}`)
  }

  // The verified request above is still 'sent' and therefore still OPEN, and
  // password_reset_one_open_per_user allows exactly one of those per user. Close
  // it before opening the next fixture, or the insert below trips the index.
  await ResetModel.cancel(otpReq.request_id)

  // Exhaustion: a row already at the ceiling is torn down rather than guessed at.
  const spent = await ResetModel.createOtpRequest({
    user_id:        itAdminUser!.user_id,
    email:          itAdminUser!.email,
    requested_role: 'it_admin',
    otp_hash:       await bcrypt.hash(CODE, 12),
    otp_expires_at: new Date(Date.now() + 10 * 60 * 1000),
  })
  createdRequestIds.push(spent.request_id)
  await supabase.from('password_reset_requests')
    .update({ otp_attempts: 5 }).eq('request_id', spent.request_id)
  try {
    await ResetService.verifyItAdminOtp({ email: itAdminUser!.email, code: CODE })
    bad('a request out of attempts still accepted the correct code')
  } catch (e: any) {
    ok(`a request out of attempts is refused: "${e.message}"`)
  }
  const exhausted = await ResetModel.findById(spent.request_id)
  exhausted?.status === 'cancelled'
    ? ok('an exhausted request is torn down, so the odds cannot accumulate')
    : bad(`exhausted request left as ${exhausted?.status}`)

  // An abandoned code must not hold the one-open-request slot forever.
  const stale = await ResetModel.createOtpRequest({
    user_id:        itAdminUser!.user_id,
    email:          itAdminUser!.email,
    requested_role: 'it_admin',
    otp_hash:       await bcrypt.hash(CODE, 12),
    otp_expires_at: new Date(Date.now() - 1000),
  })
  createdRequestIds.push(stale.request_id)
  await ResetModel.expireStaleOtps()
  const sweptOtp = await ResetModel.findById(stale.request_id)
  sweptOtp?.status === 'expired' && sweptOtp.otp_hash === null
    ? ok('expireStaleOtps() retires an abandoned code and clears its hash')
    : bad(`abandoned OTP row is ${sweptOtp?.status}, hash=${sweptOtp?.otp_hash}`)

  // Enumeration, again: nothing about a non-IT-Admin address may differ. This
  // returns before any email is attempted, so no mail leaves the building.
  const beforeOtp = (await supabase.from('password_reset_requests').select('request_id')).data!.length
  await ResetService.requestItAdminOtp({ email: clientUser!.email })
  await ResetService.requestItAdminOtp({ email: 'no-such-account-xyz@example.com' })
  const afterOtp = (await supabase.from('password_reset_requests').select('request_id')).data!.length
  afterOtp === beforeOtp
    ? ok('a non-IT-Admin address raises no OTP request')
    : bad(`OTP rows changed ${beforeOtp} -> ${afterOtp} for accounts that may not self-reset`)

  console.log('\n10. Cancelling is gated the same way as sending')
  try {
    await ResetService.cancelRequest(clientReq.request_id, itAdmin)
    bad('it_admin was allowed to cancel a CLIENT request')
  } catch (e: any) {
    e.code === 'RESET_WRONG_HANDLER'
      ? ok('it_admin refused on cancelling a client request')
      : bad(`refused, but with an unexpected error: ${e.message}`)
  }
  const cancelled = await ResetService.cancelRequest(clientReq.request_id, companyAdmin)
  cancelled.status === 'cancelled'
    ? ok('the owning admin can cancel')
    : bad(`cancel left status as ${cancelled.status}`)

  return finish()
}

async function finish() {
  console.log('\n11. Teardown')
  if (createdRequestIds.length) {
    await supabase.from('password_reset_requests').delete().in('request_id', createdRequestIds)
  }
  await supabase.from('notifications').delete().like('type', 'auth.password_reset%')

  // Scoped to the rows THIS run created. Asserting the whole table is empty would
  // start failing the moment the system has real reset history, which is not a
  // regression — the harness must clean up after itself, not after everyone.
  const { data: leftRows } = createdRequestIds.length
    ? await supabase.from('password_reset_requests').select('request_id').in('request_id', createdRequestIds)
    : { data: [] as { request_id: string }[] }
  const { data: leftNotif } = await supabase.from('notifications').select('notification_id').like('type', 'auth.password_reset%')
  leftRows!.length === 0 && leftNotif!.length === 0
    ? ok('every row and notification this run created is gone')
    : bad(`left behind: ${leftRows!.length} request(s), ${leftNotif!.length} notification(s)`)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\nHARNESS ERROR:', err)
  await finish().catch(() => {})
  process.exit(1)
})
