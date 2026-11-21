import * as groupModel from '../../models/messaging/group.model.js'
import * as push from './push.service.js'
import { groupRolesBlockReason } from '../../models/messaging/messaging.model.js'
import { createClient } from '@supabase/supabase-js'
import { broadcast } from '../../lib/realtime.js'
import type { GroupWithDetails, GroupMessageRow, GroupSystemEvent } from '../../types/messaging.types.js'

import { messageBodyColumns } from './photo.service.js'
import * as team from './team-thread.service.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import type { CreateNotificationInput, NotificationRow } from '../../types/notification.types.js'
import { PHOTO_PLACEHOLDER } from '../../schema/messaging/messaging.schema.js'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)


async function broadcastMany(channels: string[], event: string, payload: unknown): Promise<void> {
  await Promise.allSettled(channels.map(c => broadcast(c, event, payload)))
}

export async function createGroup(
  createdBy: string,
  creatorRole: string,
  name: string,
  memberIds: string[]
): Promise<{ group_id: string }> {
  // Clients talk one-to-one only (see messagingBlockReason): a group would let
  // them reach staff, and let staff who may not message clients reach them.
  if (creatorRole === 'client') throw Object.assign(new Error('Clients cannot create group chats'), { statusCode: 403 })
  if (memberIds.length < 1) throw Object.assign(new Error('A group needs at least one other member'), { statusCode: 400 })
  if (memberIds.includes(createdBy)) throw Object.assign(new Error('Do not include yourself in memberIds'), { statusCode: 400 })

  const uniqueIds = [...new Set(memberIds)]
  const { data: users, error } = await admin
    .from('users').select('user_id, status, role').in('user_id', uniqueIds)
  if (error) throw error
  const activeIds = new Set((users ?? []).filter(u => u.status === 'active').map(u => u.user_id))
  if (uniqueIds.some(id => !activeIds.has(id)))
    throw Object.assign(new Error('One or more members are invalid or inactive'), { statusCode: 400 })
  if ((users ?? []).some(u => u.role === 'client'))
    throw Object.assign(new Error('Clients cannot be added to group chats'), { statusCode: 400 })
  const roleBlock = groupRolesBlockReason([creatorRole, ...(users ?? []).map(u => u.role)])
  if (roleBlock) throw Object.assign(new Error(roleBlock), { statusCode: 400 })

  const group = await groupModel.createGroup(name, createdBy, uniqueIds)

  void broadcastMany(
    uniqueIds.map(uid => `messaging:user:${uid}`),
    'group_invite',
    { group_id: group.group_id, group_name: name }
  )

  return { group_id: group.group_id }
}

// A group holds at most this many people, the creator included — the same cap
// creating a group applies (50 invitees plus the creator).
const MAX_GROUP_SIZE = 51

async function requireAcceptedMember(groupId: string, userId: string): Promise<void> {
  const [group, member] = await Promise.all([
    groupModel.getGroupById(groupId),
    groupModel.getGroupMember(groupId, userId),
  ])
  if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 })
  if (!member || member.status !== 'accepted') throw Object.assign(new Error('Only group members can do this'), { statusCode: 403 })
}

async function acceptedMemberIds(groupId: string): Promise<string[]> {
  const { data } = await admin
    .from('group_members').select('user_id').eq('group_id', groupId).eq('status', 'accepted')
  return (data ?? []).map((m: { user_id: string }) => m.user_id)
}

/** "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Record a group event as a system line in the message history and deliver it
 * like a message, so it shows up in order with the conversation for everyone
 * already in the group. Best effort: the change itself has already happened.
 */
/**
 * One notification per group: each recipient's carries every message they
 * haven't read yet ("Name: text" lines) and replaces their previous one for
 * this group. Built per recipient because each has read up to a different
 * point; falls back to just this message if the unread read fails.
 */
async function pushGroup(
  groupId: string,
  groupName: string,
  senderId: string,
  recipients: string[],
  content: string,
  messageId: string,
  titleFor: (uid: string) => string = () => groupName,
): Promise<void> {
  const names = new Map<string, Promise<string>>()
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, push.getDisplayName(id))
    return names.get(id)!
  }
  const data = { type: 'group', group_id: groupId, message_id: messageId, sender_id: senderId }
  const tag  = `group:${groupId}`

  await Promise.allSettled(recipients.map(async (uid) => {
    const unread = await groupModel.getUnreadForPush(groupId, uid, 5).catch(() => null)
    const total  = Math.max(unread?.total ?? 1, 1)
    const lines  = unread?.messages.length
      ? await Promise.all(unread.messages.map(async (m) => `${await nameOf(m.sender_id)}: ${m.content}`))
      : [`${await nameOf(senderId)}: ${content}`]
    await push.sendToUsers([uid], {
      title: push.stackedTitle(titleFor(uid), total),
      body:  push.stackedBody(lines, total),
      data,
      tag,
    })
  }))
}

async function postSystemEvent(groupId: string, actorId: string, content: string, meta: GroupSystemEvent): Promise<void> {
  try {
    const message = await groupModel.insertSystemMessage(groupId, actorId, content, meta)
    await groupModel.touchGroup(groupId)
    const memberIds = await acceptedMemberIds(groupId)
    void broadcastMany(
      [`messaging:group:${groupId}`, ...memberIds.map(uid => `messaging:user:${uid}`)],
      'new_group_message',
      { ...message, reply_to: null },
    )
  } catch (err) {
    console.error('[messaging] failed to record group event', groupId, meta.event, err)
  }
}

async function requireGroup(groupId: string) {
  const group = await groupModel.getGroupById(groupId)
  if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 })
  return group
}

function requireCreator(group: { created_by: string }, userId: string, what: string): void {
  if (group.created_by !== userId)
    throw Object.assign(new Error(`Only the person who created the group can ${what}`), { statusCode: 403 })
}

/** Tell the group, plus anyone else named, that its details or requests changed. */
async function announceGroupChange(groupId: string, alsoNotify: string[] = []): Promise<void> {
  const joinedIds = await acceptedMemberIds(groupId)
  void broadcastMany(
    [`messaging:group:${groupId}`, ...[...new Set([...joinedIds, ...alsoNotify])].map(uid => `messaging:user:${uid}`)],
    'group_updated',
    { group_id: groupId },
  )
}

/** Only the creator renames the group; everyone in it sees the new name live. */
export async function renameGroup(groupId: string, userId: string, name: string): Promise<{ name: string }> {
  const before = await requireGroup(groupId)
  team.assertNotTeamThread(before)
  requireCreator(before, userId, 'rename it')
  if (before.name.trim() === name.trim()) return { name }
  await groupModel.renameGroup(groupId, name)

  const actor = await push.getDisplayName(userId)
  await postSystemEvent(groupId, userId, `${actor} named the group ${name}.`, {
    event: 'renamed', name, previous_name: before.name ?? null,
  })
  await announceGroupChange(groupId)
  return { name }
}

type AddCandidate = { user_id: string; first_name: string | null; last_name: string | null }

/**
 * Who of `memberIds` can actually be added: not already in the group, active,
 * never a client, and within the size cap. The same rules as creating a group.
 */
async function vetNewMembers(groupId: string, actorId: string, memberIds: string[]): Promise<AddCandidate[]> {
  const uniqueIds = [...new Set(memberIds)].filter(id => id !== actorId)
  if (!uniqueIds.length) throw Object.assign(new Error('Choose at least one person to add'), { statusCode: 400 })

  const { data: current, error: cErr } = await admin
    .from('group_members').select('user_id, status').eq('group_id', groupId)
  if (cErr) throw cErr
  const inGroup = new Set(
    (current ?? []).filter((m: { status: string }) => m.status !== 'declined').map((m: { user_id: string }) => m.user_id),
  )
  const toAdd = uniqueIds.filter(id => !inGroup.has(id))
  if (!toAdd.length) throw Object.assign(new Error('Everyone you chose is already in this group'), { statusCode: 400 })
  if (inGroup.size + toAdd.length > MAX_GROUP_SIZE)
    throw Object.assign(new Error(`A group can have at most ${MAX_GROUP_SIZE} members`), { statusCode: 400 })

  const { data: users, error } = await admin
    .from('users').select('user_id, status, role, first_name, last_name').in('user_id', toAdd)
  if (error) throw error
  const activeIds = new Set((users ?? []).filter(u => u.status === 'active').map(u => u.user_id))
  if (toAdd.some(id => !activeIds.has(id)))
    throw Object.assign(new Error('One or more members are invalid or inactive'), { statusCode: 400 })
  if ((users ?? []).some(u => u.role === 'client'))
    throw Object.assign(new Error('Clients cannot be added to group chats'), { statusCode: 400 })

  // Everyone already in (invited or joined) plus the newcomers.
  const { data: currentUsers, error: rErr } = await admin
    .from('users').select('role').in('user_id', [...inGroup])
  if (rErr) throw rErr
  const roleBlock = groupRolesBlockReason([
    ...(currentUsers ?? []).map(u => u.role),
    ...(users ?? []).map(u => u.role),
  ])
  if (roleBlock) throw Object.assign(new Error(roleBlock), { statusCode: 400 })

  return toAdd.map(id => (users ?? []).find(u => u.user_id === id)!) as AddCandidate[]
}

/** Invite people in, record the event line, and let everyone know. */
async function applyAdd(groupId: string, actorId: string, people: AddCandidate[]): Promise<void> {
  const ids = people.map(p => p.user_id)
  await groupModel.addMembers(groupId, actorId, ids)

  const names = people.map(p => `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'Someone')
  const actor = await push.getDisplayName(actorId)
  await postSystemEvent(groupId, actorId, `${actor} added ${joinNames(names)} to the group.`, {
    event: 'added', user_ids: ids, names,
  })

  const group = await groupModel.getGroupById(groupId)
  void broadcastMany(ids.map(uid => `messaging:user:${uid}`), 'group_invite', { group_id: groupId, group_name: group?.name ?? '' })
  await announceGroupChange(groupId)
}

/** Take someone out, record the event line, and let everyone (them included) know. */
async function applyRemove(groupId: string, actorId: string, targetId: string): Promise<void> {
  await groupModel.removeMember(groupId, targetId)
  const [actor, name] = await Promise.all([push.getDisplayName(actorId), push.getDisplayName(targetId)])
  await postSystemEvent(groupId, actorId, `${actor} removed ${name} from the group.`, {
    event: 'removed', user_id: targetId, name,
  })
  await announceGroupChange(groupId, [targetId])
}

/** File requests for the creator to decide, skipping any already waiting. */
async function fileRequests(groupId: string, requestedBy: string, action: 'add' | 'remove', targetIds: string[], creatorId: string): Promise<number> {
  const { data: open, error: oErr } = await admin
    .from('group_member_requests').select('target_user_id')
    .eq('group_id', groupId).eq('action', action).eq('status', 'pending').in('target_user_id', targetIds)
  if (oErr) throw oErr
  const waiting = new Set((open ?? []).map((r: { target_user_id: string }) => r.target_user_id))
  const fresh = targetIds.filter(id => !waiting.has(id))
  if (!fresh.length)
    throw Object.assign(new Error('A request for this is already waiting for the group creator'), { statusCode: 400 })

  const { error } = await admin.from('group_member_requests').insert(
    fresh.map(target_user_id => ({ group_id: groupId, requested_by: requestedBy, target_user_id, action })),
  )
  if (error) throw error

  // The creator sees the request in the group straight away.
  void broadcastMany(
    [`messaging:group:${groupId}`, `messaging:user:${creatorId}`],
    'group_updated',
    { group_id: groupId },
  )
  const [group, requester] = await Promise.all([groupModel.getGroupById(groupId), push.getDisplayName(requestedBy)])
  void push.sendToUsers([creatorId], {
    title: group?.name ?? 'Group chat',
    body:  `${requester} asked to ${action === 'add' ? 'add someone to' : 'remove someone from'} the group. Approve or decline it in the chat.`,
    data:  { type: 'group', group_id: groupId },
  })
  return fresh.length
}

/**
 * Add people to a group. The creator adds them directly; any other member's
 * choice becomes a request the creator approves or declines.
 */
export async function addMembers(
  groupId: string,
  userId: string,
  memberIds: string[],
): Promise<{ added: number; requested: number }> {
  await requireAcceptedMember(groupId, userId)
  const group  = await requireGroup(groupId)
  team.assertNotTeamThread(group)
  const people = await vetNewMembers(groupId, userId, memberIds)

  if (group.created_by === userId) {
    await applyAdd(groupId, userId, people)
    return { added: people.length, requested: 0 }
  }
  const requested = await fileRequests(groupId, userId, 'add', people.map(p => p.user_id), group.created_by)
  return { added: 0, requested }
}

/**
 * Remove someone from a group. The creator removes them directly; any other
 * member's choice becomes a request the creator approves or declines. Nobody
 * removes the creator, and the creator does not remove themselves.
 */
export async function removeMember(
  groupId: string,
  userId: string,
  targetId: string,
): Promise<{ removed: boolean; requested: boolean }> {
  await requireAcceptedMember(groupId, userId)
  const group = await requireGroup(groupId)
  team.assertNotTeamThread(group)
  if (targetId === group.created_by)
    throw Object.assign(new Error('The person who created the group cannot be removed'), { statusCode: 400 })
  if (targetId === userId)
    throw Object.assign(new Error('You cannot remove yourself'), { statusCode: 400 })

  const target = await groupModel.getGroupMember(groupId, targetId)
  if (!target || target.status === 'declined')
    throw Object.assign(new Error('That person is not in this group'), { statusCode: 404 })

  if (group.created_by === userId) {
    await applyRemove(groupId, userId, targetId)
    return { removed: true, requested: false }
  }
  await fileRequests(groupId, userId, 'remove', [targetId], group.created_by)
  return { removed: false, requested: true }
}

export interface GroupMemberRequestView {
  request_id:     string
  action:         'add' | 'remove'
  requested_by:   { user_id: string; name: string }
  target:         { user_id: string; name: string }
  created_at:     string
}

/** The creator's queue of requests waiting on them. */
export async function listMemberRequests(groupId: string, userId: string): Promise<GroupMemberRequestView[]> {
  const group = await requireGroup(groupId)
  team.assertNotTeamThread(group)
  requireCreator(group, userId, 'review member requests')

  const { data, error } = await admin
    .from('group_member_requests')
    .select(`request_id, action, created_at,
      requester:users!group_member_requests_requested_by_fkey(user_id, first_name, last_name),
      target:users!group_member_requests_target_user_id_fkey(user_id, first_name, last_name)`)
    .eq('group_id', groupId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
  if (error) throw error

  type U = { user_id: string; first_name: string | null; last_name: string | null } | null
  const name = (u: U) => (u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : '') || 'Someone'
  return (data ?? []).map((r: Record<string, unknown>) => {
    const requester = r.requester as U
    const target    = r.target as U
    return {
      request_id:   r.request_id as string,
      action:       r.action as 'add' | 'remove',
      created_at:   r.created_at as string,
      requested_by: { user_id: requester?.user_id ?? '', name: name(requester) },
      target:       { user_id: target?.user_id ?? '', name: name(target) },
    }
  })
}

/**
 * The creator approves or declines a request. Approving carries it out as if
 * the creator had done it, so the event line names them; a request overtaken
 * by events (the person already added, or already gone) is simply closed.
 */
export async function decideMemberRequest(
  groupId: string,
  requestId: string,
  userId: string,
  approve: boolean,
): Promise<void> {
  const group = await requireGroup(groupId)
  team.assertNotTeamThread(group)
  requireCreator(group, userId, 'approve member requests')

  const { data: req, error } = await admin
    .from('group_member_requests')
    .select('request_id, action, target_user_id, requested_by, status')
    .eq('request_id', requestId).eq('group_id', groupId).maybeSingle()
  if (error) throw error
  if (!req) throw Object.assign(new Error('Request not found'), { statusCode: 404 })
  if (req.status !== 'pending') throw Object.assign(new Error('This request was already decided'), { statusCode: 400 })

  // Close it first, guarded on still pending, so a double click acts once.
  const { data: closed, error: uErr } = await admin
    .from('group_member_requests')
    .update({ status: approve ? 'approved' : 'declined', decided_by: userId, decided_at: new Date().toISOString() })
    .eq('request_id', requestId).eq('status', 'pending')
    .select('request_id')
  if (uErr) throw uErr
  if (!closed?.length) throw Object.assign(new Error('This request was already decided'), { statusCode: 400 })

  if (approve) {
    const target = await groupModel.getGroupMember(groupId, req.target_user_id)
    const inGroup = !!target && target.status !== 'declined'
    if (req.action === 'add' && !inGroup) {
      const people = await vetNewMembers(groupId, userId, [req.target_user_id])
      await applyAdd(groupId, userId, people)
    } else if (req.action === 'remove' && inGroup && req.target_user_id !== group.created_by) {
      await applyRemove(groupId, userId, req.target_user_id)
    }
  }
  await announceGroupChange(groupId, [req.requested_by])
}

/**
 * The caller's group chats. A client's "8338 Team" thread is made (and its
 * members brought up to date) on their first load; Operations Managers and
 * Company Administrators are joined to every team thread, but see one only
 * once it has a message (fifteen empty client chats are noise).
 */
export async function getGroups(userId: string, role = ''): Promise<GroupWithDetails[]> {
  try {
    if (role === 'client') await team.ensureTeamThreadForClient(userId)
    else if (team.TEAM_ROLES.includes(role)) await team.joinStaffToTeamThreads(userId)
  } catch (err) {
    console.error('[messaging] team thread sync failed', userId, err)
  }
  const groups = await groupModel.getGroupsByUserId(userId)
  return role === 'client' ? groups : groups.filter(g => !g.client_id || g.last_message)
}

/**
 * Who hears about a message in a team thread (user 2026-11-22). From the
 * client: whoever on the team replied last, else every Operations Manager and
 * Company Administrator. From the team: the client only; colleagues see it
 * live and in the unread count.
 */
async function teamRecipients(thread: team.TeamThread, senderId: string, memberIds: string[]): Promise<string[]> {
  if (senderId !== thread.client_user_id) return memberIds.includes(thread.client_user_id) ? [thread.client_user_id] : []
  const { data } = await admin
    .from('group_messages').select('sender_id')
    .eq('group_id', thread.group_id).neq('sender_id', thread.client_user_id)
    .neq('message_type', 'system').is('deleted_at', null)
    .order('sent_at', { ascending: false }).limit(1)
  const last = (data?.[0] as { sender_id: string } | undefined)?.sender_id
  if (last && memberIds.includes(last)) return [last]
  return memberIds.filter(id => id !== thread.client_user_id)
}

/** Bell notices for a team-thread message (the push goes out with the chat push). */
async function notifyTeamMessage(
  thread: team.TeamThread, groupName: string, senderId: string, recipients: string[], content: string,
): Promise<void> {
  if (!recipients.length) return
  try {
    const sender = await push.getDisplayName(senderId)
    const toTeam = senderId === thread.client_user_id
    const type   = toTeam ? 'messaging.client_message' : 'messaging.team_reply'
    const title  = toTeam ? `Message from ${groupName}` : `${sender} from 8338 Team`
    const body   = toTeam ? `${sender}: ${push.preview(content)}` : push.preview(content)
    const rows: CreateNotificationInput[] = recipients.map(user_id => ({
      user_id, type, title, body, booking_id: null,
      data: {
        type, group_id: thread.group_id,
        action_url: user_id === thread.client_user_id ? '/client/dashboard?chat=messages' : '/messages',
      },
    }))
    const inserted = await notificationModel.insertMany(rows)
    void Promise.allSettled(inserted.map((row: NotificationRow) =>
      broadcast(`notifications:user:${row.user_id}`, 'new_notification', row)))
  } catch (err) {
    console.error('[messaging] team message notice failed', thread.group_id, err)
  }
}

/**
 * Outside office hours, a client's message gets one automatic line saying when
 * the team is back: at most once per closed period (the column remembers the
 * last one; a second message the same night adds nothing).
 */
async function maybeAfterHoursNotice(thread: team.TeamThread, group: { after_hours_notice_at?: string | null }): Promise<void> {
  const now = new Date()
  if (team.isOfficeOpen(now)) return
  const last = group.after_hours_notice_at ? new Date(group.after_hours_notice_at) : null
  if (last && last >= team.lastClosing(now)) return
  // Claim the notice first (guarded on the old value), so two quick messages post it once.
  const base = admin.from('group_conversations').update({ after_hours_notice_at: now.toISOString() }).eq('group_id', thread.group_id)
  const { data, error } = await (group.after_hours_notice_at
    ? base.eq('after_hours_notice_at', group.after_hours_notice_at)
    : base.is('after_hours_notice_at', null)).select('group_id')
  if (error || !data?.length) return
  await postSystemEvent(thread.group_id, thread.client_user_id, team.AFTER_HOURS_TEXT, { event: 'after_hours' })
}

export async function respondToInvite(groupId: string, userId: string, accept: boolean): Promise<void> {
  team.assertNotTeamThread(await requireGroup(groupId))
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member) throw Object.assign(new Error('Invite not found'), { statusCode: 404 })
  if (member.status !== 'pending') throw Object.assign(new Error('Invite already responded to'), { statusCode: 400 })
  await groupModel.updateMemberStatus(groupId, userId, accept ? 'accepted' : 'declined')
  // Everyone in the chat sees who joined, in order with the messages (user's
  // rule 2026-11-06). Sent in the joiner's name; a decline posts nothing (they
  // were never in the chat). An older app shows the stored sentence.
  if (accept) {
    const name = await push.getDisplayName(userId)
    await postSystemEvent(groupId, userId, `${name} joined the group.`, { event: 'joined', user_id: userId, name })
  }
  // The members list ("In the group" / "Invited") and the header count are
  // open on other people's screens: tell them, live. Without this the invite
  // stayed "pending" for everyone else until they reloaded. The responder is
  // named too, so their other devices (web + phone) catch up as well.
  await announceGroupChange(groupId, [userId])
}

export async function sendGroupMessage(
  groupId: string,
  senderId: string,
  content: string,
  replyToMessageId?: string,
  attachmentUrl?: string
): Promise<GroupMessageRow> {
  const body = messageBodyColumns(content, attachmentUrl, PHOTO_PLACEHOLDER)
  const [group, member] = await Promise.all([
    groupModel.getGroupById(groupId),
    groupModel.getGroupMember(groupId, senderId),
  ])
  if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 })

  // A team thread: bring the members up to date first, so someone archived or
  // re-roled since can't send, and a new Operations Manager is in.
  const thread = await team.teamThreadOf(group)
  if (thread) {
    const members = await team.syncTeamMembers(thread)
    if (!members.includes(senderId)) throw Object.assign(new Error('Only the client and our team can write in this chat'), { statusCode: 403 })
  } else if (!member || member.status !== 'accepted') {
    throw Object.assign(new Error('Must accept invite before messaging'), { statusCode: 403 })
  }

  let reply_to: { message_id: string; content: string; sender_id: string } | null = null
  if (replyToMessageId) {
    const { data: ref } = await admin
      .from('group_messages')
      .select('message_id, content, sender_id')
      .eq('message_id', replyToMessageId)
      .eq('group_id', groupId)
      .maybeSingle()
    if (!ref)
      throw Object.assign(new Error('Reply target not found in this group'), { statusCode: 400 })
    reply_to = ref as { message_id: string; content: string; sender_id: string }
  }

  const message = await groupModel.insertGroupMessage(groupId, senderId, body, replyToMessageId)
  await groupModel.touchGroup(groupId)

  const payload = { ...message, reply_to }

  const { data: members } = await admin
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('status', 'accepted')
  const memberIds = (members ?? []).map((m: { user_id: string }) => m.user_id)

  void broadcastMany(
    [`messaging:group:${groupId}`, ...memberIds.map(uid => `messaging:user:${uid}`)],
    'new_group_message',
    payload
  )

  if (thread) {
    const recipients = await teamRecipients(thread, senderId, memberIds)
    if (recipients.length) {
      void pushGroup(groupId, group.name, senderId, recipients, body.content, message.message_id,
        uid => (uid === thread.client_user_id ? '8338 Team' : group.name))
      void notifyTeamMessage(thread, group.name, senderId, recipients, body.content)
    }
    if (senderId === thread.client_user_id) void maybeAfterHoursNotice(thread, group)
    return payload
  }

  const recipients = memberIds.filter((uid: string) => uid !== senderId)
  if (recipients.length) {
    void pushGroup(groupId, group.name, senderId, recipients, body.content, message.message_id)
  }

  return payload
}

export async function getGroupMessages(
  groupId: string,
  userId: string,
  limit: number,
  before?: string
): Promise<GroupMessageRow[]> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member || member.status !== 'accepted') throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  return groupModel.getGroupMessages(groupId, userId, limit, before)
}

/**
 * Delete a group message for yourself only. Everyone else in the group keeps
 * seeing it. Any message can be removed from your own view, not only yours.
 */
/**
 * Unsend for everyone in the group: only the sender can. The message is gone
 * from every member's history, and open chats drop it live.
 */
export async function unsendGroupMessage(groupId: string, messageId: string, userId: string): Promise<void> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member || member.status !== 'accepted') throw Object.assign(new Error('Access denied'), { statusCode: 403 })

  const { data: msg, error } = await admin
    .from('group_messages').select('message_id, sender_id, message_type')
    .eq('message_id', messageId).eq('group_id', groupId).is('deleted_at', null).maybeSingle()
  if (error) throw error
  if (!msg) throw Object.assign(new Error('Message not found'), { statusCode: 404 })
  if (msg.sender_id !== userId || msg.message_type === 'system')
    throw Object.assign(new Error('Only the person who sent a message can unsend it'), { statusCode: 403 })

  const { error: uErr } = await admin
    .from('group_messages').update({ deleted_at: new Date().toISOString() }).eq('message_id', messageId)
  if (uErr) throw uErr

  const memberIds = await acceptedMemberIds(groupId)
  void broadcastMany(
    [`messaging:group:${groupId}`, ...memberIds.map(uid => `messaging:user:${uid}`)],
    'message_unsent',
    { message_id: messageId, group_id: groupId },
  )
}

export async function hideGroupMessage(groupId: string, messageId: string, userId: string): Promise<void> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member || member.status !== 'accepted') throw Object.assign(new Error('Access denied'), { statusCode: 403 })

  const { data: msg, error } = await admin
    .from('group_messages').select('message_id').eq('message_id', messageId).eq('group_id', groupId).maybeSingle()
  if (error) throw error
  if (!msg) throw Object.assign(new Error('Message not found'), { statusCode: 404 })

  await groupModel.hideGroupMessage(messageId, userId)
}

export async function markGroupRead(groupId: string, userId: string): Promise<void> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member || member.status !== 'accepted') throw Object.assign(new Error('Access denied'), { statusCode: 403 })

  const read_at = await groupModel.markGroupMessagesRead(groupId, userId)

  void broadcast(
    `messaging:group:${groupId}`,
    'group_read_receipt',
    { group_id: groupId, user_id: userId, read_at }
  )
}

export async function toggleGroupReaction(
  groupId: string,
  messageId: string,
  userId: string,
  emoji: string
): Promise<{ action: 'added' | 'removed' }> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member || member.status !== 'accepted') throw Object.assign(new Error('Access denied'), { statusCode: 403 })

  const result = await groupModel.toggleGroupMessageReaction(messageId, userId, emoji)

  const { data: members } = await admin
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('status', 'accepted')
  const memberIds = (members ?? []).map((m: { user_id: string }) => m.user_id)
  const payload   = { message_id: messageId, group_id: groupId, user_id: userId, emoji, action: result.action }

  void broadcastMany(
    [`messaging:group:${groupId}`, ...memberIds.map(uid => `messaging:user:${uid}`)],
    'reaction_toggle',
    payload
  )

  return result
}