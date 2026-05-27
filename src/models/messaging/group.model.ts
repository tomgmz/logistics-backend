import { supabase } from '../../lib/supabase.js'
import type {
  GroupRow,
  GroupMemberRow,
  GroupMessageRow,
  GroupWithDetails,
} from '../../types/messaging.types.js'

// ─── Group CRUD ───────────────────────────────────────────────────────────────

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

  type MyMembership = { group_id: string; status: string; last_read_at: string | null; last_read_message_id: string | null }
  const memberships = myMemberships as MyMembership[]
  const groupIds = memberships.map(m => m.group_id)
  const myStatusMap = Object.fromEntries(memberships.map(m => [m.group_id, m.status]))
  const myLastReadAtMap = Object.fromEntries(memberships.map(m => [m.group_id, m.last_read_at]))

  const { data: groups, error: groupError } = await supabase
    .from('group_conversations')
    .select('*')
    .in('group_id', groupIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (groupError) throw groupError

  // All members with user info + last_read_at (for seen-by UI)
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
    .from('group_messages')
    .select('message_id, group_id, content, sent_at, sender_id')
    .in('group_id', groupIds)
    .is('deleted_at', null)
    .order('sent_at', { ascending: false })
  if (msgError) throw msgError

  const lastMsgMap: Record<string, any> = {}
  for (const msg of lastMsgs ?? []) {
    if (!lastMsgMap[msg.group_id]) lastMsgMap[msg.group_id] = msg
  }

  // ── Fast unread count: one COUNT query per group using last_read_at ────────
  const unreadCounts = await Promise.all(
    groupIds.map(async (groupId) => {
      const lastReadAt = myLastReadAtMap[groupId]
      let query = supabase
        .from('group_messages')
        .select('message_id', { count: 'exact', head: true })
        .eq('group_id', groupId)
        .neq('sender_id', userId)
        .is('deleted_at', null)
      if (lastReadAt) query = query.gt('sent_at', lastReadAt)
      const { count } = await query
      return [groupId, count ?? 0] as [string, number]
    })
  )
  const unreadMap = Object.fromEntries(unreadCounts)

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

// ─── Messages ─────────────────────────────────────────────────────────────────

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

// ─── Read receipts ────────────────────────────────────────────────────────────
//
// Two writes happen together:
//   1. last_read_at on group_members  → source of truth for unread COUNT (fast, permanent)
//   2. group_message_reads rows       → drives "seen by" avatars (purged after 30 days)
//
// ALWAYS updates last_read_at. Only writes group_message_reads if messageIds provided.

export async function markGroupMessagesRead(
  groupId: string,
  userId: string,
  messageIds: string[]
): Promise<void> {
  const now = new Date().toISOString()

  // Always update the last-read pointer — source of truth for unread badge
  const updatePayload: Record<string, string> = { last_read_at: now }
  if (messageIds.length > 0) {
    updatePayload.last_read_message_id = messageIds[messageIds.length - 1]
  }

  const { error: memberError } = await supabase
    .from('group_members')
    .update(updatePayload)
    .eq('group_id', groupId)
    .eq('user_id', userId)
  if (memberError) throw memberError

  // Write per-message rows for "seen by" UI only when IDs are provided
  if (messageIds.length > 0) {
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
  }
}

// ─── Reactions ────────────────────────────────────────────────────────────────
//
// UNIQUE(message_id, user_id) enforced at DB → one reaction per user per message.
// Toggle logic:
//   • same emoji already there → remove (toggle off)
//   • different emoji           → replace (update)
//   • nothing yet               → insert

export async function toggleGroupMessageReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<{ action: 'added' | 'removed' }> {
  // Check current reaction for this user on this message (any emoji)
  const { data: existing } = await supabase
    .from('group_message_reactions')
    .select('id, emoji')
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    if ((existing as any).emoji === emoji) {
      // Same emoji → toggle off
      await supabase.from('group_message_reactions').delete().eq('id', (existing as any).id)
      return { action: 'removed' }
    }
    // Different emoji → replace (update in place to respect UNIQUE constraint)
    await supabase
      .from('group_message_reactions')
      .update({ emoji })
      .eq('id', (existing as any).id)
    return { action: 'added' }
  }

  // No existing reaction → insert
  await supabase.from('group_message_reactions').insert({ message_id: messageId, user_id: userId, emoji })
  return { action: 'added' }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export async function touchGroup(groupId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('group_conversations').update({ last_message_at: now, updated_at: now }).eq('group_id', groupId)
  if (error) throw error
}