
export type ConversationContextType = 'direct' | 'booking_transit'

export type UserRole =
  | 'admin'
  | 'general_manager'
  | 'fleet_manager'
  | 'operations_manager'
  | 'client'
  | 'driver'
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
  /** 'system' = a group event (renamed, people added), rendered as a centered line. 'image' = a photo. */
  message_type?: 'text' | 'image' | 'system'
  /** The photo of an 'image' message; `content` is then its caption (or the "📷 Photo" placeholder). */
  attachment_url?: string | null
  attachment_stamped?: boolean
  meta?: GroupSystemEvent | null
}

export type GroupSystemEvent =
  | { event: 'renamed'; name: string; previous_name?: string | null }
  | { event: 'added'; user_ids: string[]; names: string[] }
  | { event: 'removed'; user_id: string; name: string }

export interface ConversationParticipant {
  user_id: string
  first_name: string | null
  last_name: string | null
  role: UserRole
  email: string
}

/** A booking a conversation is about, for the reference shown beside a name. */
export interface BookingRefRow {
  booking_id: string
  reference_number: string | null
}

export interface ConversationWithDetails extends ConversationRow {
  other_user: ConversationParticipant
  /** The booking the conversation was started for (booking_id), if any. */
  booking: BookingRefRow | null
  last_message: { message_id: string; content: string; sent_at: string; sender_id: string } | null
  unread_count: number
}

export interface MessagableUser {
  user_id: string
  first_name: string | null
  last_name: string | null
  role: UserRole
  email: string
  booking_id?: string
  /** Client <-> driver only: the open bookings that link the two. */
  bookings?: BookingRefRow[]
}

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
  message_type?: 'text' | 'image' | 'system'
  attachment_url?: string | null
  attachment_stamped?: boolean
}

export interface GroupWithDetails extends GroupRow {
  members: GroupMemberWithUser[]
  last_message: { message_id: string; content: string; sent_at: string; sender_id: string } | null
  unread_count: number
  my_status: 'pending' | 'accepted' | 'declined'
}