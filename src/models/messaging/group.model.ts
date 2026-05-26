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
    .from('group_members').select('group_id, status').eq('user_id', userId).neq('status', 'declined')
  if (memError) throw memError
  if (!myMemberships || myMemberships.length === 0) return []

  const groupIds = (myMemberships as { group_id: string; status: string }[]).map(m => m.group_id)
  const myStatusMap: Record<string, string> = Object.fromEntries(
    (myMemberships as { group_id: string; status: string }[]).map(m => [m.group_id, m.status])
  )

  const { data: groups, error: groupError } = await supabase
    .from('group_conversations').select('*').in('group_id', groupIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (groupError) throw groupError

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

  const { data: lastMsgs, error: msgError } = await supabase
    .from('group_messages').select('message_id, group_id, content, sent_at, sender_id')
    .in('group_id', groupIds).order('sent_at', { ascending: false })
  if (msgError) throw msgError

  const lastMsgMap: Record<string, any> = {}
  for (const msg of lastMsgs ?? []) {
    if (!lastMsgMap[msg.group_id]) lastMsgMap[msg.group_id] = msg
  }

  const { data: readRows } = await supabase
    .from('group_message_reads').select('group_id, message_id').eq('user_id', userId).in('group_id', groupIds)
  const readMessageIds = new Set((readRows ?? []).map((r: any) => r.message_id))

  const { data: allGroupMsgs } = await supabase
    .from('group_messages').select('message_id, group_id, sender_id').in('group_id', groupIds).neq('sender_id', userId)

  const unreadMap: Record<string, number> = {}
  for (const msg of allGroupMsgs ?? []) {
    if (!readMessageIds.has((msg as any).message_id)) {
      unreadMap[(msg as any).group_id] = (unreadMap[(msg as any).group_id] ?? 0) + 1
    }
  }

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
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (before) query = query.lt('sent_at', before)
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as unknown as GroupMessageRow[]).reverse()
}

export async function markGroupMessagesRead(groupId: string, userId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return
  const rows = messageIds.map(message_id => ({
    message_id, group_id: groupId, user_id: userId, read_at: new Date().toISOString(),
  }))
  const { error } = await supabase.from('group_message_reads').upsert(rows, { onConflict: 'message_id,user_id' })
  if (error) throw error
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