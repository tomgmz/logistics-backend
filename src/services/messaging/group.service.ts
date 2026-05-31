import * as groupModel from '../../models/messaging/group.model.js'
import { createClient } from '@supabase/supabase-js'
import type { GroupWithDetails, GroupMessageRow } from '../../types/messaging.types.js'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// ─── Broadcast helper ─────────────────────────────────────────────────────────
// Per Supabase docs: calling .send() BEFORE .subscribe() uses HTTP (REST).
// This is the correct server-side pattern — no WebSocket needed.

async function broadcast(channel: string, event: string, payload: unknown): Promise<void> {
  const ch = admin.channel(channel)
  await ch.send({ type: 'broadcast', event, payload })
}

async function broadcastMany(channels: string[], event: string, payload: unknown): Promise<void> {
  await Promise.allSettled(channels.map(c => broadcast(c, event, payload)))
}

// ─── Service ──────────────────────────────────────────────────────────────────

export async function createGroup(
  createdBy: string,
  name: string,
  memberIds: string[]
): Promise<{ group_id: string }> {
  if (memberIds.length < 1) throw Object.assign(new Error('A group needs at least one other member'), { statusCode: 400 })
  if (memberIds.includes(createdBy)) throw Object.assign(new Error('Do not include yourself in memberIds'), { statusCode: 400 })

  const group = await groupModel.createGroup(name, createdBy, memberIds)

  void broadcastMany(
    memberIds.map(uid => `messaging:user:${uid}`),
    'group_invite',
    { group_id: group.group_id, group_name: name }
  )

  return { group_id: group.group_id }
}

export async function getGroups(userId: string): Promise<GroupWithDetails[]> {
  return groupModel.getGroupsByUserId(userId)
}

export async function respondToInvite(groupId: string, userId: string, accept: boolean): Promise<void> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member) throw Object.assign(new Error('Invite not found'), { statusCode: 404 })
  if (member.status !== 'pending') throw Object.assign(new Error('Invite already responded to'), { statusCode: 400 })
  await groupModel.updateMemberStatus(groupId, userId, accept ? 'accepted' : 'declined')
}

export async function sendGroupMessage(
  groupId: string,
  senderId: string,
  content: string,
  replyToMessageId?: string
): Promise<GroupMessageRow> {
  const [group, member] = await Promise.all([
    groupModel.getGroupById(groupId),
    groupModel.getGroupMember(groupId, senderId),
  ])
  if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 })
  if (!member || member.status !== 'accepted') throw Object.assign(new Error('Must accept invite before messaging'), { statusCode: 403 })

  const message = await groupModel.insertGroupMessage(groupId, senderId, content, replyToMessageId)
  await groupModel.touchGroup(groupId)

  // Attach reply snippet so realtime consumers see it immediately without a re-fetch
  let reply_to: { message_id: string; content: string; sender_id: string } | null = null
  if (replyToMessageId) {
    const { data: ref } = await admin
      .from('group_messages')
      .select('message_id, content, sender_id')
      .eq('message_id', replyToMessageId)
      .maybeSingle()
    if (ref) reply_to = ref as { message_id: string; content: string; sender_id: string }
  }
  const payload = { ...message, reply_to }

  // Get accepted member IDs for fan-out
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
  return groupModel.getGroupMessages(groupId, limit, before)
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