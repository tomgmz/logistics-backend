import { supabase } from '../../lib/supabase.js'
import { CLIENT_MESSAGING_STAFF_ROLES } from '../../models/messaging/messaging.model.js'

/**
 * A client's "8338 Team" chat (user 2026-11-22): one group per client company
 * (group_conversations.client_id) holding the client and every active
 * Operations Manager and Company Administrator — a shared team inbox, as
 * Intercom / Zendesk / Front run it. Membership is kept in step here, never by
 * hand: a new Operations Manager joins every thread the next time a list loads,
 * an archived or re-roled one drops out the next time the thread is used.
 *
 * Staff who join an existing thread start with everything read (last_read_at
 * now), so years of history don't arrive as unread.
 */

export const TEAM_ROLES = CLIENT_MESSAGING_STAFF_ROLES

export interface TeamThread { group_id: string; client_id: string; client_user_id: string }

const err = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })

/** The active Operations Managers and Company Administrators. */
export async function teamStaffIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from('users').select('user_id').eq('status', 'active').in('role', TEAM_ROLES)
  if (error) throw error
  return (data ?? []).map((u: { user_id: string }) => u.user_id)
}

/** The team thread a group is, or null for an ordinary group chat. */
export async function teamThreadOf(group: { group_id: string; client_id?: string | null }): Promise<TeamThread | null> {
  if (!group.client_id) return null
  const { data, error } = await supabase
    .from('clients').select('user_id').eq('client_id', group.client_id).maybeSingle()
  if (error) throw error
  if (!data?.user_id) return null
  return { group_id: group.group_id, client_id: group.client_id, client_user_id: data.user_id as string }
}

/** Refuse a hand-made change (rename, add, remove, invites) to a team thread. */
export function assertNotTeamThread(group: { client_id?: string | null }): void {
  if (group.client_id) throw err('The 8338 Team chat is managed automatically: its name and members cannot be changed', 400)
}

/**
 * Make the members exactly the client + the current team. Adds the missing
 * (joined, everything read), re-admits anyone marked declined, and takes out
 * whoever is no longer on the team (archived, inactive or a new role). Their
 * old messages stay.
 */
export async function syncTeamMembers(thread: TeamThread): Promise<string[]> {
  const staff   = await teamStaffIds()
  const desired = new Set([thread.client_user_id, ...staff])

  const { data: rows, error } = await supabase
    .from('group_members').select('user_id, status').eq('group_id', thread.group_id)
  if (error) throw error
  const current = new Map((rows ?? []).map((r: { user_id: string; status: string }) => [r.user_id, r.status]))

  const now     = new Date().toISOString()
  const missing = [...desired].filter(id => !current.has(id))
  const revive  = [...desired].filter(id => current.has(id) && current.get(id) !== 'accepted')
  const gone    = [...current.keys()].filter(id => !desired.has(id) && current.get(id) !== 'declined')

  if (missing.length) {
    const { error: iErr } = await supabase.from('group_members').upsert(
      missing.map(user_id => ({
        group_id: thread.group_id, user_id, invited_by: thread.client_user_id,
        status: 'accepted', joined_at: now, last_read_at: now,
      })),
      { onConflict: 'group_id,user_id', ignoreDuplicates: true },
    )
    if (iErr) throw iErr
  }
  if (revive.length) {
    const { error: rErr } = await supabase.from('group_members')
      .update({ status: 'accepted', joined_at: now, last_read_at: now })
      .eq('group_id', thread.group_id).in('user_id', revive)
    if (rErr) throw rErr
  }
  if (gone.length) {
    const { error: gErr } = await supabase.from('group_members')
      .update({ status: 'declined', joined_at: null })
      .eq('group_id', thread.group_id).in('user_id', gone)
    if (gErr) throw gErr
  }
  return [...desired]
}

/**
 * The client's team thread, created the first time their Messages list loads
 * (staff don't see it until it has a message). Two loads at once can't make
 * two: the unique index on client_id turns the second insert into a re-read.
 */
export async function ensureTeamThreadForClient(clientUserId: string): Promise<TeamThread | null> {
  const { data: client, error } = await supabase
    .from('clients').select('client_id, company_name').eq('user_id', clientUserId).maybeSingle()
  if (error) throw error
  if (!client) return null

  const find = async () => {
    const { data, error: fErr } = await supabase
      .from('group_conversations').select('group_id').eq('client_id', client.client_id).maybeSingle()
    if (fErr) throw fErr
    return data?.group_id as string | undefined
  }

  let groupId = await find()
  if (!groupId) {
    const { data, error: cErr } = await supabase
      .from('group_conversations')
      .insert({ name: (client.company_name as string | null)?.trim() || 'Client', created_by: clientUserId, client_id: client.client_id })
      .select('group_id').single()
    if (cErr && cErr.code !== '23505') throw cErr
    groupId = data?.group_id ?? await find()
  }
  if (!groupId) return null

  const thread = { group_id: groupId, client_id: client.client_id as string, client_user_id: clientUserId }
  await syncTeamMembers(thread)
  return thread
}

/**
 * A staff member's list: join them to every team thread they're missing from,
 * so a new Operations Manager sees the clients' chats straight away.
 */
export async function joinStaffToTeamThreads(staffUserId: string): Promise<void> {
  const { data: threads, error } = await supabase
    .from('group_conversations').select('group_id').not('client_id', 'is', null)
  if (error) throw error
  const ids = (threads ?? []).map((t: { group_id: string }) => t.group_id)
  if (!ids.length) return

  const { data: mine, error: mErr } = await supabase
    .from('group_members').select('group_id, status').eq('user_id', staffUserId).in('group_id', ids)
  if (mErr) throw mErr
  const accepted = new Set((mine ?? []).filter((m: { status: string }) => m.status === 'accepted').map((m: { group_id: string }) => m.group_id))
  const known    = new Set((mine ?? []).map((m: { group_id: string }) => m.group_id))
  const now      = new Date().toISOString()

  const add = ids.filter(id => !known.has(id))
  if (add.length) {
    const { error: iErr } = await supabase.from('group_members').upsert(
      add.map(group_id => ({ group_id, user_id: staffUserId, invited_by: staffUserId, status: 'accepted', joined_at: now, last_read_at: now })),
      { onConflict: 'group_id,user_id', ignoreDuplicates: true },
    )
    if (iErr) throw iErr
  }
  const revive = ids.filter(id => known.has(id) && !accepted.has(id))
  if (revive.length) {
    const { error: rErr } = await supabase.from('group_members')
      .update({ status: 'accepted', joined_at: now, last_read_at: now })
      .eq('user_id', staffUserId).in('group_id', revive)
    if (rErr) throw rErr
  }
}

// ── Office hours (Mon–Sat 8 AM – 5 PM, Manila) ───────────────────────────────

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000
const OPEN_HOUR  = 8
const CLOSE_HOUR = 17

/** Manila wall clock for an instant, as a UTC-based Date (read with getUTC*). */
const manila = (d: Date) => new Date(d.getTime() + MANILA_OFFSET_MS)

export function isOfficeOpen(now = new Date()): boolean {
  const m = manila(now)
  const day = m.getUTCDay()           // 0 = Sunday
  const h   = m.getUTCHours()
  return day !== 0 && h >= OPEN_HOUR && h < CLOSE_HOUR
}

/** When the office last closed (5 PM of the latest Mon–Sat at or before now). */
export function lastClosing(now = new Date()): Date {
  const m = manila(now)
  for (let back = 0; back < 8; back++) {
    const day = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() - back, CLOSE_HOUR))
    if (day.getUTCDay() === 0) continue
    const closingUtc = new Date(day.getTime() - MANILA_OFFSET_MS)
    if (closingUtc <= now) return closingUtc
  }
  return new Date(now.getTime() - 7 * 24 * 3600_000)
}

export const AFTER_HOURS_TEXT =
  'Our team is in Monday to Saturday, 8 AM to 5 PM, and will reply when we are back. ' +
  'For a problem with a delivery on the road right now, call us at +63 9685 536 8975.'
