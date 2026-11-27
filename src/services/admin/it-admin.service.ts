import { supabase } from '../../lib/supabase.js'
import * as ITAdminModel from '../../models/admin/it-admin.model.js'
import { activateUserWithUnban, banArchivedAuthUser, deactivateUserWithBan } from './user-auth-status.service.js'
import * as WebauthnModel from '../../models/auth/webauthn.model.js'
import { ITAdminHandover, ITAdminSuccessorInput, StartHandoverInput, UpdateITAdminInput } from '../../types/it-admin.types.js'
import { logEvent } from '../../lib/log-event.js'
import { formatManilaTimestamp, generateSecurePassword, sendItAdminTakeoverEmail, sendWelcomeEmail, TEMP_PASSWORD_TTL_DAYS } from '../../lib/mailer.js'
import { logSystem } from '../../lib/log-system.js'
import { deleteAuthUserSafely } from '../../lib/auth-helpers.js'
import { invalidateUserPermissions } from '../../middlewares/moduleAccess.middleware.js'
import * as ResetModel from '../../models/auth/password-reset.model.js'
import { assertPhoneAvailable } from '../../lib/phone-unique.js'
import { errorMessage } from '../../lib/error-message.js'
import { invalidateStandinCache } from '../../lib/it-standin.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import type { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'

/** An error the controller can turn into a specific status code. */
function coded(message: string, code: string): Error {
  const err = new Error(message)
  ;(err as any).code = code
  return err
}

/** The render target: how long a handover is expected to take (not a deadline). */
export const RENDER_DAYS = 30

/**
 * Refuse to take the seat holder (the active IT Admin not serving a render
 * period) out of service.
 *
 * This is not bureaucratic tidiness. Every staff password reset routes to the
 * 'it_admin' queue, a Company Admin is refused on those rows by
 * assertOwnsRequest(), and recipient lookups filter on status = 'active' — so
 * with nobody active, staff resets become invisible AND unactionable, with only a
 * console.error to show for it.
 *
 * The seat only changes hands through the handover. A predecessor still serving
 * their render period may be deactivated early: the seat holder covers the queue.
 */
async function assertNotSeatHolder(userId: string): Promise<void> {
  const seat = await ITAdminModel.findSeatHolders()
  if (seat.some((s) => s.user_id === userId)) {
    throw coded(
      'This is the current IT Administrator. The role changes hands only when they hand it ' +
      'over to a successor — removing them outright would leave every staff password ' +
      'reset with nobody able to action it.',
      'LAST_IT_ADMIN',
    )
  }
}

/**
 * Refuse to let someone switch off their own IT Admin account.
 *
 * The routes are gated with authorize('admin','it_admin'), so an IT Admin reaches
 * these endpoints — and findAll() hides the caller from their own list, so they
 * cannot even see that they are the last one before doing it.
 */
function assertNotSelf(userId: string, actorId?: string | null): void {
  if (actorId && actorId === userId) {
    throw coded(
      'You cannot deactivate or remove your own IT Administrator account.',
      'IT_ADMIN_SELF_ACTION',
    )
  }
}

export async function getAllITAdmins(actorId?: string | null) {
  return ITAdminModel.findAll(actorId ?? undefined)
}

export async function getITAdminById(userId: string) {
  const itAdmin = await ITAdminModel.findById(userId)
  if (!itAdmin) throw new Error('IT Administrator not found')
  return itAdmin
}

export async function updateITAdmin(
  userId:   string,
  input:    UpdateITAdminInput,
  actorId?: string | null,
) {
  await assertPhoneAvailable(input.phone, userId)

  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: input.email,
    })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await ITAdminModel.update(userId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_updated',
    description: `IT Administrator ${userId} updated`,
  })

  return result
}

export async function deleteITAdmin(
  userId:   string,
  actorId?: string | null,
) {
  assertNotSelf(userId, actorId)
  await assertNotSeatHolder(userId)

  const result = await ITAdminModel.remove(userId)
  await banArchivedAuthUser(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_archived',
    description: `IT Administrator ${userId} archived`,
  })

  return result
}

export async function deactivateITAdmin(
  userId:   string,
  actorId?: string | null,
) {
  assertNotSelf(userId, actorId)
  await assertNotSeatHolder(userId)

  // deactivateUserWithBan also signs them out everywhere.
  const result = await deactivateUserWithBan(userId, 'it_admin', 'it_admin_deactivated', 'IT Administrator', actorId)
  invalidateUserPermissions(userId)

  return result
}

export async function activateITAdmin(
  userId:   string,
  actorId?: string | null,
) {
  return activateUserWithUnban(userId, 'it_admin', 'it_admin_activated', 'IT Administrator', actorId)
}

/* ── Handover ──────────────────────────────────────────────────────────────
 *
 * Two steps since 2026-10-25 (migration 20261025010000_it_admin_handover_two_step):
 *
 *   1. The IT Admin STARTS the handover on themselves: their 30-day render begins
 *      (users.render_ends_at). The successor may be named now or later.
 *   2. They ADD the successor whenever one is found: an it_admin account with an
 *      emailed temporary password (7 days).
 *   3. The successor CONFIRMS by setting their own password (first sign-in, or
 *      the IT Admin emailed-code reset). completeHandoverOnConfirm ends the
 *      render at once and archives the outgoing account.
 *
 * The 30 days is a target only. Without a confirmed successor the outgoing IT
 * Admin stays active past it, because there must never be zero IT Admins: every
 * password reset routes to the it_admin queue.
 */

/**
 * The General Manager handles the handover whenever the IT Administrator is
 * not there (user 2026-11-27; replaces the named Company Administrator
 * stand-in of 2026-11-06). There is only ever one General Manager
 * (one-general-manager), so nobody is "named": the stand-in is whoever is the
 * active General Manager, read fresh each time. A General Manager replaced
 * mid-handover therefore hands it on to the new one by itself.
 */
async function findActiveGm() {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role, status, first_name, last_name, email')
    .eq('role', 'general_manager')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/**
 * The open handover `actorId` may act on, or a coded refusal: the outgoing IT
 * Admin's own, or (with allowStandin) the active General Manager's, at any
 * point of the handover (they step in whenever the IT Administrator is not
 * there). The General Manager may add / re-send / replace the successor; only
 * the outgoing IT Admin may cancel.
 */
async function openHandoverOf(actorId: string, opts: { allowStandin?: boolean } = {}) {
  const handover = await ITAdminModel.findOpenHandover()
  const isOutgoing = !!handover && handover.outgoing_id === actorId
  const isStandin  = !!handover && !!opts.allowStandin && (await findActiveGm())?.user_id === actorId
  if (!handover || (!isOutgoing && !isStandin)) {
    throw coded('There is no handover in progress on your account.', 'NO_OPEN_HANDOVER')
  }
  return handover
}

/** In-app + push notice to one or more users about the handover. Best effort. */
async function notifyHandover(userIds: string[], title: string, body: string, actionUrl: string): Promise<void> {
  try {
    if (!userIds.length) return
    const type = 'it_admin.handover'
    const data = { type, action_url: actionUrl }
    const rows: CreateNotificationInput[] = userIds.map((user_id) => ({ user_id, type, title, body, booking_id: null, data }))
    const inserted = await notificationModel.insertMany(rows)
    void Promise.allSettled(inserted.map((row: NotificationRow) =>
      broadcast(`notifications:user:${row.user_id}`, 'new_notification', row)))
    void push.sendToUsers(userIds, { title, body, data })
  } catch (err) {
    console.error('[it-admin] handover notice failed', err)
  }
}

function personName(u: { first_name: string | null; last_name: string | null; email?: string | null } | null): string {
  return (u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : '') || u?.email || 'the General Manager'
}

const GM_DASHBOARD = '/general_manager/dashboard'

/**
 * Emergency takeover (2026-11-27): the General Manager starts a handover on an
 * IT Administrator who can't be reached. They are emailed and told at once and
 * can cancel within this many days (Bitwarden / LastPass emergency access,
 * Apple account recovery: a waiting period the owner can stop). After it the
 * General Manager takes over exactly as on an overdue resignation.
 */
export const EMERGENCY_WAIT_DAYS = 3

/** Started by the General Manager, not by the IT Administrator on themselves. */
function isEmergency(h: ITAdminHandover): boolean {
  return !!h.created_by && h.created_by !== h.outgoing_id
}

/**
 * The General Manager asks to take over an IT Administrator who can't be
 * reached (active but silent, locked, or deactivated).
 */
export async function startEmergencyTakeover(reason: string, actorId: string) {
  const gm = await findActiveGm()
  if (!gm || gm.user_id !== actorId) throw coded('Only the General Manager can take over the IT Administrator role.', 'NOT_GM')
  const seat = await ITAdminModel.findSeatForTakeover()
  if (!seat) {
    throw coded('There is no IT Administrator to take over. Add the new IT Administrator instead.', 'SEAT_EMPTY')
  }
  let handover: ITAdminHandover | null
  try {
    handover = await ITAdminModel.startEmergencyHandover(seat.user_id, gm.user_id, reason, EMERGENCY_WAIT_DAYS)
  } catch (err) {
    if ((err as Error).message === 'HANDOVER_OPEN') throw rpcRefusal('HANDOVER_OPEN')!
    throw err
  }
  if (!handover) throw coded('The IT Administrator changed meanwhile. Reload and try again.', 'SEAT_CHANGED')
  invalidateUserPermissions(seat.user_id)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_takeover_requested',
    description: `General Manager ${personName(gm)} asked to take over from IT Administrator ${seat.email} (${seat.user_id}); takes effect ${handover.render_due_at} unless cancelled. Reason: ${reason}`,
  })

  const takesOverAt = formatManilaTimestamp(handover.render_due_at)
  // Email first: an IT Administrator who has gone quiet may never open the app.
  void sendItAdminTakeoverEmail({ to: seat.email, firstName: seat.first_name ?? null, gmName: personName(gm), reason, takesOverAt })
    .catch((err: unknown) => logSystem({
      log_level: 'error', event_type: 'auth_event', source: 'it-admin.service',
      message:   `IT Administrator takeover email failed for ${seat.email}: ${errorMessage(err)}`,
    }))
  void notifyHandover([seat.user_id], 'The General Manager asked to take over your role',
    `${personName(gm)} could not reach you. If you are still here, choose Cancel Handover before ${takesOverAt}; otherwise they take over then.`,
    '/it_admin/dashboard')
  const admins = await notificationModel.resolveUserIdsByRoles(['admin']).catch(() => [] as string[])
  void notifyHandover(admins, 'IT Administrator takeover requested',
    `${personName(gm)} (General Manager) asked to take over the IT Administrator role; it takes effect ${takesOverAt} unless the IT Administrator cancels.`,
    '/admin/dashboard')
  return { handover }
}

/**
 * No IT Administrator account at all (and no handover open): the General
 * Manager adds one directly, with an emailed temporary password (2026-11-27).
 */
export async function addItAdminToEmptySeat(input: ITAdminSuccessorInput, actorId: string) {
  const gm = await findActiveGm()
  if (!gm || gm.user_id !== actorId) throw coded('Only the General Manager can add the IT Administrator.', 'NOT_GM')
  if (await ITAdminModel.findOpenHandover()) throw rpcRefusal('HANDOVER_OPEN')!
  if (await ITAdminModel.findSeatForTakeover()) {
    throw coded('There is already an IT Administrator. Use Take Over if they cannot be reached.', 'SEAT_TAKEN')
  }
  await assertPhoneAvailable(input.phone)

  const password = generateSecurePassword()
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: input.email, password, email_confirm: true, user_metadata: { role: 'it_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)
  const id = authData.user.id
  let created
  try {
    created = await ITAdminModel.create(id, { ...input, created_by: actorId } as Parameters<typeof ITAdminModel.create>[1])
  } catch (err) {
    const ok = await deleteAuthUserSafely(id)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user with ID:', id)
    if ((err as { code?: string })?.code === '23505') {
      throw coded('There is already an IT Administrator. Reload the page.', 'SEAT_TAKEN')
    }
    throw err
  }
  sendWelcomeEmail({ to: input.email, firstName: input.first_name ?? null, role: 'it_admin', password })
    .catch((err: unknown) => console.error(`WELCOME_EMAIL_FAILED for it_admin ${id}:`, errorMessage(err)))
  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_added_by_gm',
    description: `No IT Administrator on record: General Manager ${personName(gm)} added ${input.email} (${id})`,
  })
  return created
}

/**
 * Refuse to deactivate or archive the General Manager while they stand in as
 * IT Administrator: that would leave the IT seat with nobody until the new IT
 * Administrator confirms. Before day 30 nothing is refused; whoever is General
 * Manager on day 30 takes over.
 */
export async function assertNotStandin(userId: string): Promise<void> {
  const handover = await ITAdminModel.findOpenHandover()
  if (!handover || !handover.standin_activated_at || handover.standin_id !== userId) return
  throw coded(
    'This General Manager is standing in as IT Administrator. They can be deactivated or archived once the new IT Administrator has set their password.',
    'STANDIN_LOCKED',
  )
}

/** Record the current General Manager on the handover (for the panels and the log). */
async function pointStandinAtGm(handover: ITAdminHandover, gm: { user_id: string }) {
  if (handover.standin_id === gm.user_id) return
  await ITAdminModel.updateHandover(handover.handover_id, {
    standin_id:       gm.user_id,
    standin_named_at: new Date().toISOString(),
  })
}

/**
 * Day 30 (render scheduler): an overdue handover with no confirmed successor
 * hands the IT Administrator powers to the active General Manager and archives
 * the outgoing IT Admin. With no active General Manager nothing happens (the
 * outgoing stays, as before) and the outgoing IT Admin is told. Returns how
 * many stand-ins took over.
 */
export async function activateOverdueStandins(): Promise<number> {
  const handover = await ITAdminModel.findOpenHandover()
  if (!handover || handover.standin_activated_at) return 0
  if (new Date(handover.render_due_at).getTime() > Date.now()) return 0

  // A successor who has already set their password is completed by
  // completeMissedHandovers, not taken over.
  if (handover.successor_id) {
    const { data: succ } = await supabase.from('users')
      .select('must_change_password, status').eq('user_id', handover.successor_id).maybeSingle()
    if (succ && succ.status === 'active' && !succ.must_change_password) return 0
  }

  const standin = await findActiveGm()
  if (!standin) {
    console.error('[it-admin] no active General Manager to take over; the outgoing IT Administrator stays')
    void notifyHandover([handover.outgoing_id], 'Nobody can take over yet',
      'There is no active General Manager to take over the IT Administrator work, so your account stays open. Add your replacement.',
      '/it_admin/dashboard')
    return 0
  }

  // Guarded on still-not-activated, so two server instances act once.
  const { data: claimed, error } = await supabase
    .from('it_admin_handovers')
    .update({ standin_activated_at: new Date().toISOString(), standin_id: standin.user_id, standin_named_at: new Date().toISOString() })
    .eq('handover_id', handover.handover_id)
    .is('standin_activated_at', null)
    .is('ended_at', null)
    .is('cancelled_at', null)
    .select('handover_id')
  if (error) throw error
  if (!claimed?.length) return 0
  invalidateStandinCache()
  invalidateUserPermissions(standin.user_id)

  // The resigned IT Administrator's 30 days are up: their account closes now.
  await archiveAccount(handover.outgoing_id).catch((err) =>
    console.error('[it-admin] archiving the outgoing IT Administrator failed', handover.outgoing_id, err))

  logEvent({
    user_id:     null,
    log_type:    'user_management',
    action:      'it_admin_standin_activated',
    description: `${isEmergency(handover) ? 'Emergency takeover not cancelled within the waiting period' : 'IT Administrator render overdue with no confirmed replacement'}: General Manager ${personName(standin)} (${standin.user_id}) now holds the IT Administrator powers; the outgoing IT Administrator ${handover.outgoing_id} was archived`,
  })

  void notifyHandover([standin.user_id], 'You are now standing in as IT Administrator',
    (isEmergency(handover) ? 'The IT Administrator did not cancel the takeover. ' : 'No replacement IT Administrator confirmed within 30 days. ') +
    'You now have the IT Administrator pages (User Management, password resets, Logs) until the new IT Administrator sets their password. Add them from your dashboard.',
    GM_DASHBOARD)
  // The Company Administrators should know who holds IT now.
  const others = await notificationModel.resolveUserIdsByRoles(['admin']).catch(() => [] as string[])
  void notifyHandover(others, 'IT Administrator stand-in',
    `${personName(standin)} (General Manager) is standing in as IT Administrator until a new IT Administrator starts.`,
    '/admin/dashboard')
  return 1
}

/** Turns an RPC's RAISE into the same coded refusal the controller maps. */
function rpcRefusal(message: string): Error | null {
  for (const [token, text] of [
    ['NOT_SEAT_HOLDER',   'Only the current IT Administrator can start a handover.'],
    ['HANDOVER_OPEN',     'A handover is already in progress.'],
    ['NO_OPEN_HANDOVER',  'There is no handover in progress on your account.'],
    ['SUCCESSOR_PENDING', 'A replacement is already waiting to confirm. Replace them first.'],
  ] as const) {
    if (message.includes(token)) return coded(text, token)
  }
  return null
}

/**
 * Where the caller stands: holding the role (no handover), or rendering, with
 * the successor (if any) and whether they have confirmed yet.
 */
export async function getHandoverStatus(actorId: string) {
  const handover  = await ITAdminModel.findOpenHandover()
  const gm        = await findActiveGm()
  const actorIsGm = gm?.user_id === actorId
  // The General Manager sees the handover from its first day (user 2026-11-27).
  const isStandin = !!handover && actorIsGm
  const mine      = handover && (handover.outgoing_id === actorId || isStandin) ? handover : null

  // With nothing open, the General Manager sees who holds the seat (or that
  // nobody does), for Take Over / Add the IT Administrator.
  let seat: { user_id: string; email: string; first_name: string | null; last_name: string | null; status: string; last_login_at: string | null } | null = null
  if (actorIsGm && !handover) seat = await ITAdminModel.findSeatForTakeover()

  let successor: {
    user_id: string; email: string; first_name: string | null; last_name: string | null
    temp_password_expires_at: string | null
  } | null = null
  if (mine?.successor_id) {
    const { data } = await supabase
      .from('users')
      .select('user_id, email, first_name, last_name, temp_password_expires_at')
      .eq('user_id', mine.successor_id)
      .maybeSingle()
    successor = data ?? null
  }

  // Who takes (or took) over: the General Manager of the day.
  const standin = gm
    ? { user_id: gm.user_id, email: gm.email, first_name: gm.first_name, last_name: gm.last_name }
    : null

  return {
    render_days: RENDER_DAYS,
    emergency_wait_days: EMERGENCY_WAIT_DAYS,
    /** 'outgoing' = the resigning IT Admin; 'standin' = the General Manager, who handles it when the IT Administrator is not there. */
    viewer: mine ? (isStandin ? 'standin' : 'outgoing') : actorIsGm ? 'standin' : null,
    /** General Manager with nothing open: the IT Administrator on record, or null when the seat is empty. */
    seat: actorIsGm && !handover ? seat : undefined,
    handover: mine && {
      handover_id:    mine.handover_id,
      reason:         mine.reason,
      started_at:     mine.started_at,
      render_due_at:  mine.render_due_at,
      overdue:        new Date(mine.render_due_at).getTime() < Date.now(),
      successor,
      standin,
      standin_active: !!mine.standin_activated_at,
      /** Started by the General Manager because the IT Administrator could not be reached. */
      emergency:      isEmergency(mine),
    },
  }
}

/**
 * Step 1: start the render. With `successor` given, also step 2 in the same
 * call (the replacement is already known).
 */
export async function startHandover(input: StartHandoverInput, actorId: string) {
  // Checked before the render starts: a handover never exists without someone
  // to take over, so the outgoing IT Admin can't stay past the 30 days.
  const gm = await findActiveGm()
  if (!gm) {
    throw coded('There is no active General Manager to take over if your replacement has not started in 30 days. Ask for a General Manager account first.', 'BAD_STANDIN')
  }

  const { data, error } = await supabase.rpc('start_it_admin_handover', {
    p_outgoing_id: actorId,
    p_reason:      input.reason,
    p_render_days: RENDER_DAYS,
  })
  if (error) throw rpcRefusal(error.message) ?? new Error(`Could not start the handover: ${error.message}`)

  const handover = data as ITAdminHandover
  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_handover_started',
    description: `IT Administrator handover started; render target ${handover.render_due_at}. Reason: ${input.reason}`,
  })

  // A failed successor here leaves a started handover with none added yet,
  // which the panel shows with "Add your replacement": nothing to undo.
  await pointStandinAtGm(handover, gm)
  const due = new Date(handover.render_due_at).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
  })
  void notifyHandover([gm.user_id], 'The IT Administrator is leaving',
    `You handle the handover whenever the IT Administrator is not there: you can add, re-send or replace their replacement from your dashboard. If nobody has set their password by ${due}, you take over the IT Administrator's work until the new IT Administrator starts.`,
    GM_DASHBOARD)
  const successor = input.successor ? await addSuccessor(input.successor, actorId) : null
  return { handover, successor }
}

/** Step 2: the successor's account, created with an emailed temporary password. */
export async function addSuccessor(input: ITAdminSuccessorInput, actorId: string) {
  const handover = await openHandoverOf(actorId, { allowStandin: true })
  if (handover.successor_id) throw rpcRefusal('SUCCESSOR_PENDING')!
  // An emergency takeover's waiting period is the IT Administrator's chance to
  // say "I'm here": a replacement confirming inside it would close their
  // account before it ends. The General Manager adds one once it is over.
  if (isEmergency(handover) && handover.outgoing_id !== actorId && !handover.standin_activated_at) {
    throw coded(`You can add the new IT Administrator once the waiting period ends (${formatManilaTimestamp(handover.render_due_at)}), if the IT Administrator has not cancelled.`, 'TAKEOVER_WAITING')
  }
  await assertPhoneAvailable(input.phone)

  const password = generateSecurePassword()
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password,
    email_confirm: true,
    user_metadata: { role: 'it_admin' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)
  const incomingId = authData.user.id

  const { data: created, error: rpcError } = await supabase.rpc('add_it_admin_successor', {
    // The RPC finds the handover by its outgoing IT Admin (also when the
    // stand-in adds the successor; the audit log below names the real actor).
    p_outgoing_id: handover.outgoing_id,
    p_incoming_id: incomingId,
    p_email:       input.email,
    p_first_name:  input.first_name,
    p_last_name:   input.last_name,
    p_middle_name: input.middle_name ?? null,
    p_suffix:      input.suffix ?? null,
    p_phone:       input.phone ?? null,
  })
  if (rpcError) {
    // The RPC rolled back; only the Auth identity made a moment ago is left.
    const ok = await deleteAuthUserSafely(incomingId)
    if (!ok) console.error('ROLLBACK FAILED. Orphan auth user with ID:', incomingId)
    throw rpcRefusal(rpcError.message) ?? new Error(`Could not add the replacement: ${rpcError.message}`)
  }

  sendWelcomeEmail({ to: input.email, firstName: input.first_name ?? null, role: 'it_admin', password })
    .catch((err: unknown) => {
      // Not a dead end: "Resend sign-in email" on the panel issues a new one.
      console.error(`WELCOME_EMAIL_FAILED for incoming it_admin ${incomingId}:`, errorMessage(err))
    })

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_successor_added',
    description: `Replacement IT Administrator ${input.email} (${incomingId}) added; the handover ends when they set their own password`,
  })

  return created
}

/** A new temporary password for a successor who lost or let the first one expire. */
export async function resendSuccessorSignIn(actorId: string) {
  const handover = await openHandoverOf(actorId, { allowStandin: true })
  if (!handover.successor_id) throw coded('No replacement has been added yet.', 'NO_SUCCESSOR')

  const { data: successor, error } = await supabase
    .from('users')
    .select('user_id, email, first_name, must_change_password')
    .eq('user_id', handover.successor_id)
    .maybeSingle()
  if (error) throw error
  if (!successor) throw coded('The replacement account was not found.', 'NO_SUCCESSOR')
  if (!successor.must_change_password) {
    throw coded('The replacement has already set their own password.', 'SUCCESSOR_CONFIRMED')
  }

  const password = generateSecurePassword()
  const { error: authError } = await supabase.auth.admin.updateUserById(successor.user_id, { password })
  if (authError) throw new Error(`Could not issue a new password: ${authError.message}`)
  // A fresh 7 days for the new temporary password (TEMP_PASSWORD_TTL_DAYS). The
  // expiry trigger only stamps it when must_change_password turns on; while it
  // stays on, a value written here is kept.
  const expires = new Date(Date.now() + TEMP_PASSWORD_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { error: stampErr } = await supabase.from('users')
    .update({ temp_password_expires_at: expires }).eq('user_id', successor.user_id)
  if (stampErr) throw stampErr

  await sendWelcomeEmail({ to: successor.email, firstName: successor.first_name ?? null, role: 'it_admin', password })

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_successor_reissued',
    description: `New sign-in email sent to replacement IT Administrator ${successor.email}`,
  })
}

/** Archive an unconfirmed successor so a different one can be added. */
export async function replaceSuccessor(actorId: string) {
  const handover = await openHandoverOf(actorId, { allowStandin: true })
  if (!handover.successor_id) throw coded('No replacement has been added yet.', 'NO_SUCCESSOR')
  await archiveUnconfirmedSuccessor(handover.successor_id, actorId)
  await ITAdminModel.updateHandover(handover.handover_id, { successor_id: null, successor_added_at: null })
}

/**
 * Stop the handover before anyone confirmed: the IT Administrator keeps the
 * role. The IT Administrator may cancel any of theirs (an emergency takeover is
 * how they say "I'm still here"); the General Manager may withdraw an emergency
 * takeover they started, during its waiting period.
 */
export async function cancelHandover(actorId: string) {
  const handover = await openHandoverOf(actorId, { allowStandin: true })
  const byOutgoing = handover.outgoing_id === actorId
  if (!byOutgoing && !isEmergency(handover)) {
    throw coded('Only the IT Administrator can cancel their handover.', 'NOT_OUTGOING')
  }
  if (handover.standin_activated_at) {
    throw coded('The General Manager has already taken over; the handover ends when the new IT Administrator sets their password.', 'STANDIN_ACTIVE')
  }
  if (handover.successor_id) await archiveUnconfirmedSuccessor(handover.successor_id, actorId)

  await ITAdminModel.updateHandover(handover.handover_id, { cancelled_at: new Date().toISOString() })
  const { error } = await supabase.from('users').update({ render_ends_at: null }).eq('user_id', handover.outgoing_id)
  if (error) throw error
  invalidateUserPermissions(handover.outgoing_id)

  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_handover_cancelled',
    description: isEmergency(handover)
      ? `Emergency takeover cancelled by the ${byOutgoing ? 'IT Administrator' : 'General Manager'}; the role stays with the current IT Administrator`
      : 'IT Administrator handover cancelled; the role stays with the current IT Administrator',
  })

  // The other side of an emergency takeover hears that it stopped.
  if (isEmergency(handover)) {
    const other = byOutgoing ? handover.created_by : handover.outgoing_id
    if (other) {
      void notifyHandover([other], 'IT Administrator takeover cancelled',
        byOutgoing
          ? 'The IT Administrator answered and cancelled the takeover. They keep the role.'
          : 'The General Manager withdrew the takeover request. You keep the role.',
        byOutgoing ? GM_DASHBOARD : '/it_admin/dashboard')
    }
  }
}

async function archiveUnconfirmedSuccessor(successorId: string, actorId: string) {
  const { data } = await supabase.from('users').select('must_change_password').eq('user_id', successorId).maybeSingle()
  if (data && !data.must_change_password) {
    throw coded('The replacement has already set their own password.', 'SUCCESSOR_CONFIRMED')
  }
  await archiveAccount(successorId)
  logEvent({
    user_id:     actorId,
    log_type:    'user_management',
    action:      'it_admin_archived',
    description: `Unconfirmed replacement IT Administrator ${successorId} archived`,
  })
}

/** Archive: status archived, signed out everywhere, login banned, passkeys ended. */
async function archiveAccount(userId: string) {
  await ITAdminModel.remove(userId)
  await banArchivedAuthUser(userId)
  await WebauthnModel.revokeAllForUser(userId, null, 'Account archived').catch((err) =>
    console.error('[it-admin] passkey revoke failed', userId, err),
  )
  invalidateUserPermissions(userId)
}

/**
 * Step 3, called when an IT Admin sets their own password (first sign-in or the
 * emailed-code reset). If they are the pending successor of the open handover,
 * the render ends now and the outgoing account is archived. A no-op otherwise.
 * Never throws: the password change itself has already succeeded.
 */
export async function completeHandoverOnConfirm(userId: string): Promise<void> {
  try {
    const { data: outgoingId, error } = await supabase.rpc('complete_it_admin_handover', { p_successor_id: userId })
    if (error) throw error
    if (!outgoingId) return
    // The stand-in (if one took over) loses the IT Administrator powers now.
    invalidateStandinCache()

    // Already archived when a stand-in took over on day 30; archiving again is harmless.
    await archiveAccount(outgoingId as string)

    // The new IT Admin inherits an honest reset queue.
    await ResetModel.expireStale().catch(() => {})
    await ResetModel.expireStaleOtps().catch(() => {})

    logEvent({
      user_id:     userId,
      log_type:    'user_management',
      action:      'it_admin_handover_completed',
      description: `IT Administrator handover completed: ${userId} set their password and holds the role; the previous IT Administrator ${outgoingId} was archived`,
    })
  } catch (err) {
    console.error('[it-admin] completing the handover failed; the render scheduler retries', userId, err)
  }
}

/**
 * Safety net for the render scheduler: finish any handover whose successor has
 * already set their password but was not closed (e.g. the server stopped mid-way).
 * Returns how many it closed. Nothing ends on a timer any more.
 */
export async function completeMissedHandovers(): Promise<number> {
  const missed = await ITAdminModel.findConfirmedButOpen()
  for (const h of missed) await completeHandoverOnConfirm(h.successor_id)
  return missed.length
}
