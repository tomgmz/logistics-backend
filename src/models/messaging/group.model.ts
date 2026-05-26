import { supabase } from '../../lib/supabase.js'
import type {
  GroupRow,
  GroupMemberRow,
  GroupMessageRow,
  GroupWithDetails,
} from '../../types/messaging.types.js'

export async function createGroup(name: string, createdBy: string, memberIds: string[]): Promise<GroupRow> {
  const { data: group, error: groupError } = await supabase
    .from('group_conversations').insert({ name, created_by: createdBy }).select().single()
  if (groupError) throw groupError

  const members = [
    { group_id: group.group_id, user_id: createdBy, invited_by: createdBy, status: 'accepted', joined_at: new Date().toISOString() },
    ...memberIds.map(uid => ({ group_id: group.group_id, user_id: uid, invited_by: createdBy, status: 'pending', joined_at: null })),
  ]
  const { error: memberError } = await supabase.from('group_members').insert(members)
  if (memberError) throw memberError
  return group as GroupRow
}

export async function getGroupsByUserId(userId: string): Promise<GroupWithDetails[]> {
  const { data: myMemberships, error: memError } = await supabase
    .from('group_members')
    .select('group_id, status, last_read_at, last_read_message_id')
    .eq('user_id', userId)
    .neq('status', 'declined')
  if (memError) throw memError
  if (!myMemberships || myMemberships.length === 0) return []

  type MyMembership = {
    group_id: string
    status: string
    last_read_at: string | null
    last_read_message_id: string | null
  }

  const memberships = myMemberships as MyMembership[]
  const groupIds = memberships.map(m => m.group_id)

  // Build lookup maps from my membership rows
  const myStatusMap: Record<string, string> = Object.fromEntries(
    memberships.map(m => [m.group_id, m.status])
  )
  const myLastReadAtMap: Record<string, string | null> = Object.fromEntries(
    memberships.map(m => [m.group_id, m.last_read_at])
  )

  // Fetch group metadata
  const { data: groups, error: groupError } = await supabase
    .from('group_conversations')
    .select('*')
    .in('group_id', groupIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (groupError) throw groupError

  // Fetch all members with user info
  const { data: allMembers, error: allMembersError } = await supabase
    .from('group_members')
    .select('*, user:users!group_members_user_id_fkey(user_id, first_name, last_name, role, email)')
    .in('group_id', groupIds)
  if (allMembersError) throw allMembersError

  const membersByGroup: Record<string, any[]> = {}
  for (const m of allMembers ?? []) {
    if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = []
    membersByGroup[m.group_id].push(m)
  }

  // Fetch last message per group
  const { data: lastMsgs, error: msgError } = await supabase
    .from('group_messages')
    .select('message_id, group_id, content, sent_at, sender_id')
    .in('group_id', groupIds)
    .order('sent_at', { ascending: false })
  if (msgError) throw msgError

  const lastMsgMap: Record<string, any> = {}
  for (const msg of lastMsgs ?? []) {
    if (!lastMsgMap[msg.group_id]) lastMsgMap[msg.group_id] = msg
  }

  // ── Fast unread count using last_read_at from group_members ──────────────
  // Count messages sent after my last_read_at, excluding my own messages.
  // This replaces the old approach that fetched ALL messages + ALL read rows.
  const unreadMap: Record<string, number> = {}

  await Promise.all(
    groupIds.map(async (groupId) => {
      const lastReadAt = myLastReadAtMap[groupId]

      let query = supabase
        .from('group_messages')
        .select('message_id', { count: 'exact', head: true })
        .eq('group_id', groupId)
        .neq('sender_id', userId)
        .is('deleted_at', null)

      if (lastReadAt) {
        // Only count messages newer than last read
        query = query.gt('sent_at', lastReadAt)
      }
      // If no last_read_at, ALL non-own messages are unread

      const { count } = await query
      unreadMap[groupId] = count ?? 0
    })
  )

  return (groups as GroupRow[]).map(g => ({
    ...g,
    members: membersByGroup[g.group_id] ?? [],
    last_message: lastMsgMap[g.group_id] ?? null,
    unread_count: unreadMap[g.group_id] ?? 0,
    my_status: (myStatusMap[g.group_id] ?? 'pending') as 'pending' | 'accepted' | 'declined',
  }))
}

export async function getGroupById(groupId: string): Promise<GroupRow | null> {
  const { data, error } = await supabase
    .from('group_conversations').select('*').eq('group_id', groupId).maybeSingle()
  if (error) throw error
  return data as GroupRow | null
}

export async function getGroupMember(groupId: string, userId: string): Promise<GroupMemberRow | null> {
  const { data, error } = await supabase
    .from('group_members').select('*').eq('group_id', groupId).eq('user_id', userId).maybeSingle()
  if (error) throw error
  return data as GroupMemberRow | null
}

export async function updateMemberStatus(groupId: string, userId: string, status: 'accepted' | 'declined'): Promise<void> {
  const { error } = await supabase
    .from('group_members')
    .update({ status, joined_at: status === 'accepted' ? new Date().toISOString() : null })
    .eq('group_id', groupId).eq('user_id', userId)
  if (error) throw error
}

export async function insertGroupMessage(
  groupId: string,
  senderId: string,
  content: string,
  replyToMessageId?: string
): Promise<GroupMessageRow> {
  const { data, error } = await supabase
    .from('group_messages')
    .insert({
      group_id: groupId,
      sender_id: senderId,
      content,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    })
    .select()
    .single()
  if (error) throw error
  return data as GroupMessageRow
}

export async function getGroupMessages(groupId: string, limit: number, before?: string): Promise<GroupMessageRow[]> {
  let query = supabase
    .from('group_messages')
    .select(`
      *,
      reply_to:group_messages!reply_to_message_id(message_id, content, sender_id),
      reactions:group_message_reactions(emoji, user_id)
    `)
    .eq('group_id', groupId)
    .is('deleted_at', null)
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (before) query = query.lt('sent_at', before)
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as unknown as GroupMessageRow[]).reverse()
}

export async function markGroupMessagesRead(
  groupId: string,
  userId: string,
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0) return

  const now = new Date().toISOString()

  // 1. Upsert per-message read rows (used for per-message receipts / purge job)
  const rows = messageIds.map(message_id => ({
    message_id,
    group_id: groupId,
    user_id: userId,
    read_at: now,
  }))
  const { error: readError } = await supabase
    .from('group_message_reads')
    .upsert(rows, { onConflict: 'message_id,user_id' })
  if (readError) throw readError

  // 2. Update last_read_at + last_read_message_id on group_members
  //    This is what the fast unread count in getGroupsByUserId reads from.
  //    messageIds are passed in sent_at order (oldest → newest) from the service layer,
  //    so the last element is the most recent message read.
  const lastMessageId = messageIds[messageIds.length - 1]
  const { error: memberError } = await supabase
    .from('group_members')
    .update({
      last_read_at: now,
      last_read_message_id: lastMessageId,
    })
    .eq('group_id', groupId)
    .eq('user_id', userId)
  if (memberError) throw memberError
}

export async function toggleGroupMessageReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<{ action: 'added' | 'removed' }> {
  const { data: existing } = await supabase
    .from('group_message_reactions')
    .select('id').eq('message_id', messageId).eq('user_id', userId).eq('emoji', emoji).maybeSingle()
  if (existing) {
    await supabase.from('group_message_reactions').delete().eq('id', (existing as any).id)
    return { action: 'removed' }
  }
  await supabase.from('group_message_reactions').insert({ message_id: messageId, user_id: userId, emoji })
  return { action: 'added' }
}

export async function touchGroup(groupId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('group_conversations').update({ last_message_at: now, updated_at: now }).eq('group_id', groupId)
  if (error) throw error
}