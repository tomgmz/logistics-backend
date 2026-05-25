import * as groupModel from '../../models/messaging/group.model.js'
import { createClient } from '@supabase/supabase-js'
import type { GroupWithDetails, GroupMessageRow } from '../../types/messaging.types.js'

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function broadcastGroupMessage(message: GroupMessageRow, memberIds: string[]): Promise<void> {
  await Promise.allSettled([
    // Per-group channel (open chat windows listen here)
    supabaseAdmin.channel(`messaging:group:${message.group_id}`).send({
      type: 'broadcast',
      event: 'new_group_message',
      payload: message,
    }),
    // Per-user channels (conversation list / header badge)
    ...memberIds.map(uid =>
      supabaseAdmin.channel(`messaging:user:${uid}`).send({
        type: 'broadcast',
        event: 'new_group_message',
        payload: message,
      })
    ),
  ])
}

async function broadcastGroupInvite(groupId: string, inviteeIds: string[], groupName: string): Promise<void> {
  await Promise.allSettled(
    inviteeIds.map(uid =>
      supabaseAdmin.channel(`messaging:user:${uid}`).send({
        type: 'broadcast',
        event: 'group_invite',
        payload: { group_id: groupId, group_name: groupName },
      })
    )
  )
}

async function broadcastGroupReadReceipt(
  groupId: string,
  userId: string,
  readAt: string
): Promise<void> {
  await supabaseAdmin.channel(`messaging:group:${groupId}`).send({
    type: 'broadcast',
    event: 'group_read_receipt',
    payload: { group_id: groupId, user_id: userId, read_at: readAt },
  })
}

export async function createGroup(
  createdBy: string,
  name: string,
  memberIds: string[]
): Promise<{ group_id: string }> {
  if (memberIds.length < 1) {
    throw Object.assign(new Error('A group needs at least one other member'), { statusCode: 400 })
  }
  if (memberIds.includes(createdBy)) {
    throw Object.assign(new Error('Do not include yourself in memberIds'), { statusCode: 400 })
  }

  const group = await groupModel.createGroup(name, createdBy, memberIds)

  broadcastGroupInvite(group.group_id, memberIds, name).catch(err =>
    console.error('[Realtime] group_invite broadcast failed:', err)
  )

  return { group_id: group.group_id }
}

export async function getGroups(userId: string): Promise<GroupWithDetails[]> {
  return groupModel.getGroupsByUserId(userId)
}

export async function respondToInvite(
  groupId: string,
  userId: string,
  accept: boolean
): Promise<void> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member) {
    throw Object.assign(new Error('Invite not found'), { statusCode: 404 })
  }
  if (member.status !== 'pending') {
    throw Object.assign(new Error('Invite already responded to'), { statusCode: 400 })
  }

  await groupModel.updateMemberStatus(groupId, userId, accept ? 'accepted' : 'declined')
}

export async function sendGroupMessage(
  groupId: string,
  senderId: string,
  content: string
): Promise<GroupMessageRow> {
  const group = await groupModel.getGroupById(groupId)
  if (!group) {
    throw Object.assign(new Error('Group not found'), { statusCode: 404 })
  }

  const member = await groupModel.getGroupMember(groupId, senderId)
  if (!member || member.status !== 'accepted') {
    throw Object.assign(new Error('You must accept the group invite before messaging'), { statusCode: 403 })
  }

  const message = await groupModel.insertGroupMessage(groupId, senderId, content)
  await groupModel.touchGroup(groupId)

  // Get all accepted member IDs to broadcast to
  const { data: members } = await supabaseAdmin
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('status', 'accepted')

  const memberIds = (members ?? []).map((m: any) => m.user_id)

  broadcastGroupMessage(message, memberIds).catch(err =>
    console.error('[Realtime] group broadcast failed:', err)
  )

  return message
}

export async function getGroupMessages(
  groupId: string,
  userId: string,
  limit: number,
  before?: string
): Promise<GroupMessageRow[]> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member || member.status !== 'accepted') {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  }

  return groupModel.getGroupMessages(groupId, limit, before)
}

export async function markGroupRead(
  groupId: string,
  userId: string,
  messageIds: string[]
): Promise<void> {
  const member = await groupModel.getGroupMember(groupId, userId)
  if (!member || member.status !== 'accepted') {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  }

  await groupModel.markGroupMessagesRead(groupId, userId, messageIds)

  broadcastGroupReadReceipt(groupId, userId, new Date().toISOString()).catch(err =>
    console.error('[Realtime] group read receipt broadcast failed:', err)
  )
}