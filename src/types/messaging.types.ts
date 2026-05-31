// ─── Shared ───────────────────────────────────────────────────────────────────

export type ConversationContextType = 'direct' | 'booking_transit'

export type UserRole =
  | 'admin'
  | 'general_manager'
  | 'fleet_admin'
  | 'operations_admin'
  | 'accountant'
  | 'client'
  | 'driver'
  | 'vendor'
  | 'it_admin'

export interface ReactionRow {
  emoji: string
  user_id: string
}

export interface ReplyPreview {
  message_id: string
  content: string
  sender_id: string
}

// ─── DM ──────────────────────────────────────────────────────────────────────

export interface ConversationRow {
  conversation_id: string
  participant_a_id: string
  participant_b_id: string
  context_type: ConversationContextType
  booking_id: string | null
  created_at: string
  updated_at: string
  last_message_at: string | null
  participant_a_last_read_at: string | null
  participant_b_last_read_at: string | null
}

export interface MessageRow {
  message_id: string
  conversation_id: string
  sender_id: string
  receiver_id: string
  content: string
  sent_at: string
  deleted_by_sender: boolean
  deleted_by_receiver: boolean
  reply_to_message_id: string | null
  reply_to: ReplyPreview | null
  reactions: ReactionRow[]
}

export interface ConversationParticipant {
  user_id: string
  first_name: string | null
  last_name: string | null
  role: UserRole
  email: string
}

export interface ConversationWithDetails extends ConversationRow {
  other_user: ConversationParticipant
  last_message: { message_id: string; content: string; sent_at: string; sender_id: string } | null
  unread_count: number
  // participant_a_last_read_at and participant_b_last_read_at inherited from ConversationRow
}

export interface MessagableUser {
  user_id: string
  first_name: string | null
  last_name: string | null
  role: UserRole
  email: string
  booking_id?: string
}

// ─── Group ────────────────────────────────────────────────────────────────────

export interface GroupRow {
  group_id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
  last_message_at: string | null
}

export interface GroupMemberRow {
  id: string
  group_id: string
  user_id: string
  invited_by: string
  status: 'pending' | 'accepted' | 'declined'
  joined_at: string | null
  created_at: string
  last_read_at: string | null
  last_read_message_id: string | null
}

export interface GroupMemberWithUser extends GroupMemberRow {
  user: {
    user_id: string
    first_name: string | null
    last_name: string | null
    role: UserRole
    email: string
  }
}

export interface GroupMessageRow {
  message_id: string
  group_id: string
  sender_id: string
  content: string
  sent_at: string
  reply_to_message_id: string | null
  reply_to: ReplyPreview | null
  reactions: ReactionRow[]
}

export interface GroupWithDetails extends GroupRow {
  members: GroupMemberWithUser[]
  last_message: { message_id: string; content: string; sent_at: string; sender_id: string } | null
  unread_count: number
  my_status: 'pending' | 'accepted' | 'declined'
}