// Admin-mediated password reset requests.
//
// A user cannot reset their own password unattended: they raise a request, it
// lands in one admin queue, and that admin sends the one-time link. Which queue
// is decided once at request time and frozen on the row — see handlerGroupFor().

export type ResetHandlerGroup = 'company_admin' | 'it_admin'

export type ResetRequestStatus =
  | 'pending'    // raised by the user, waiting on an admin
  | 'sent'       // admin sent the link; token is live until token_expires_at
  | 'completed'  // user set a new password (this is what lifts the lockout)
  | 'cancelled'  // admin dismissed it
  | 'expired'    // the sent link ran out before it was used

export interface PasswordResetRequestRow {
  request_id:       string
  user_id:          string
  email:            string
  requested_role:   string
  handler_group:    ResetHandlerGroup
  status:           ResetRequestStatus
  token_hash:       string | null
  token_expires_at: string | null
  sent_by:          string | null
  sent_at:          string | null
  completed_at:     string | null
  requested_ip:     string | null
  last_notified_at: string | null
  created_at:       string
  updated_at:       string
}

// A queue row joined with the requester's name, for the admin table.
export interface PasswordResetQueueItem extends PasswordResetRequestRow {
  first_name: string | null
  last_name:  string | null
}
