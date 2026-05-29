import { supabase } from '../../lib/supabase.js'
import type {
  GroupRow,
  GroupMemberRow,
  GroupMessageRow,
  GroupWithDetails,
} from '../../types/messaging.types.js'

// ─── Groups ────────────────────────────────────────────────────────────────────

export async function createGroup(name: string, createdBy: string, memberIds: string[]): Promise<GroupRow> {
  const { data: group, error } = await supabase
    .from('group_conversations').insert({ name, created_by: createdBy }).select().single()
  if (error) throw error

  const members = [
    { group_id: group.group_id, user_id: createdBy, invited_by: createdBy, status: 'accepted', joined_at: new Date().toISOString() },
    ...memberIds.map(uid => ({ group_id: group.group_id, user_id: uid, invited_by: createdBy, status: 'pending', joined_at: null })),
  ]
  const { error: mErr } = await supabase.from('group_members').insert(members)
  if (mErr) throw mErr
  return group as GroupRow
}

export async function getGroupsByUserId(userId: string): Promise<GroupWithDetails[]> {
  // 1. My memberships — last_read_at drives unread count
  const { data: myData, error: myErr } = await supabase
    .from('group_members')
    .select('group_id, status, last_read_at, last_read_message_id')
    .eq('user_id', userId)
    .neq('status', 'declined')
  if (myErr) throw myErr
  if (!myData?.length) return []

  type MyRow = { group_id: string; status: string; last_read_at: string | null; last_read_message_id: string | null }
  const mine      = myData as MyRow[]
  const groupIds  = mine.map(m => m.group_id)
  const statusMap = Object.fromEntries(mine.map(m => [m.group_id, m.status]))
  const readAtMap = Object.fromEntries(mine.map(m => [m.group_id, m.last_read_at]))

  // 2. Fetch groups, all members, and ALL messages in 3 parallel queries.
  //    We use allMsgs for BOTH last_message AND unread counts in a single pass —
  //    eliminating the previous N parallel COUNT queries.
  const [
    { data: groups,     error: gErr },
    { data: allMembers, error: mErr },
    { data: allMsgs,    error: lErr },
  ] = await Promise.all([
    supabase.from('group_conversations')
      .select('*')
      .in('group_id', groupIds)
      .order('last_message_at', { ascending: false, nullsFirst: false }),

    supabase.from('group_members')
      .select('*, user:users!group_members_user_id_fkey(user_id, first_name, last_name, role, email)')
      .in('group_id', groupIds),

    // Fetch all non-deleted messages across all groups in one query.
    // Used for: (a) last_message per group, (b) in-memory unread count.
    supabase.from('group_messages')
      .select('message_id, group_id, content, sent_at, sender_id')
      .in('group_id', groupIds)
      .is('deleted_at', null)
      .order('sent_at', { ascending: false }),
  ])
  if (gErr) throw gErr
  if (mErr) throw mErr
  if (lErr) throw lErr

  // ── Build membersByGroup map ──────────────────────────────────────────────
  const membersByGroup: Record<string, unknown[]> = {}
  for (const m of allMembers ?? []) {
    const row = m as { group_id: string }
    ;(membersByGroup[row.group_id] ??= []).push(m)
  }

  // ── Single pass over allMsgs: derive last_message + unread count ──────────
  // This replaces the previous N parallel COUNT queries with O(total_messages)
  // in-memory computation — one iteration, zero additional DB round trips.
  type MsgRow = { message_id: string; group_id: string; content: string; sent_at: string; sender_id: string }

  const lastMsgMap: Record<string, MsgRow>    = {}
  const unreadMap:  Record<string, number>    = {}

  for (const m of (allMsgs ?? []) as MsgRow[]) {
    // Last message: allMsgs is ordered desc, first seen per group wins
    if (!lastMsgMap[m.group_id]) lastMsgMap[m.group_id] = m

    // Unread count: skip own messages, count those newer than last_read_at
    if (m.sender_id === userId) continue
    const readAt = readAtMap[m.group_id]
    const isUnread = readAt === null || m.sent_at > readAt
    if (isUnread) unreadMap[m.group_id] = (unreadMap[m.group_id] ?? 0) + 1
  }

  return (groups as GroupRow[]).map(g => ({
    ...g,
    members:      (membersByGroup[g.group_id] ?? []) as GroupWithDetails['members'],
    last_message: lastMsgMap[g.group_id]
      ? { message_id: lastMsgMap[g.group_id].message_id, content: lastMsgMap[g.group_id].content, sent_at: lastMsgMap[g.group_id].sent_at, sender_id: lastMsgMap[g.group_id].sender_id }
      : null,
    unread_count: unreadMap[g.group_id] ?? 0,
    my_status:    (statusMap[g.group_id] ?? 'pending') as 'pending' | 'accepted' | 'declined',
  }))
}

export async function getGroupById(id: string): Promise<GroupRow | null> {
  const { data, error } = await supabase.from('group_conversations').select('*').eq('group_id', id).maybeSingle()
  if (error) throw error
  return data as GroupRow | null
}

export async function getGroupMember(groupId: string, userId: string): Promise<GroupMemberRow | null> {
  const { data, error } = await supabase.from('group_members').select('*').eq('group_id', groupId).eq('user_id', userId).maybeSingle()
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
    .insert({ group_id: groupId, sender_id: senderId, content, reply_to_message_id: replyToMessageId ?? null })
    .select()
    .single()
  if (error) throw error
  return data as GroupMessageRow
}

export async function getGroupMessages(groupId: string, limit: number, before?: string): Promise<GroupMessageRow[]> {
  let q = supabase
    .from('group_messages')
    .select('*, reply_to:group_messages!reply_to_message_id(message_id, content, sender_id), reactions:group_message_reactions(emoji, user_id)')
    .eq('group_id', groupId)
    .is('deleted_at', null)
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (before) q = q.lt('sent_at', before)
  const { data, error } = await q
  if (error) throw error
  return ((data ?? []) as unknown as GroupMessageRow[]).reverse()
}

// ─── Read receipts ────────────────────────────────────────────────────────────
// ALWAYS updates last_read_at on group_members (source of truth for unread badge).
// Writes group_message_reads only when messageIds are provided (for "seen by" UI).

export async function markGroupMessagesRead(
  groupId: string,
  userId: string,
  messageIds: string[]
): Promise<void> {
  const now   = new Date().toISOString()
  const patch: Record<string, string> = { last_read_at: now }
  if (messageIds.length > 0) patch.last_read_message_id = messageIds[messageIds.length - 1]

  const { error: memberErr } = await supabase
    .from('group_members').update(patch).eq('group_id', groupId).eq('user_id', userId)
  if (memberErr) throw memberErr

  if (messageIds.length > 0) {
    const rows = messageIds.map(mid => ({ message_id: mid, group_id: groupId, user_id: userId, read_at: now }))
    const { error: readErr } = await supabase
      .from('group_message_reads').upsert(rows, { onConflict: 'message_id,user_id' })
    if (readErr) throw readErr
  }
}

// ─── Reactions ────────────────────────────────────────────────────────────────
// UNIQUE(message_id, user_id): one reaction per user per message.
// Same emoji → remove. Different emoji → update in place. None → insert.

export async function toggleGroupMessageReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<{ action: 'added' | 'removed' }> {
  const { data: existing } = await supabase
    .from('group_message_reactions').select('id, emoji').eq('message_id', messageId).eq('user_id', userId).maybeSingle()

  if (existing) {
    const row = existing as { id: string; emoji: string }
    if (row.emoji === emoji) {
      await supabase.from('group_message_reactions').delete().eq('id', row.id)
      return { action: 'removed' }
    }
    await supabase.from('group_message_reactions').update({ emoji }).eq('id', row.id)
    return { action: 'added' }
  }

  await supabase.from('group_message_reactions').insert({ message_id: messageId, user_id: userId, emoji })
  return { action: 'added' }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export async function touchGroup(groupId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase.from('group_conversations').update({ last_message_at: now, updated_at: now }).eq('group_id', groupId)
  if (error) throw error
}