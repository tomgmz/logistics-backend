// Admin-mediated password reset requests.
//
// A user cannot reset their own password unattended: they raise a request, it
// lands in one admin queue, and that admin sends the one-time link. Which queue
// is decided once at request time and frozen on the row — see handlerGroupFor().

export type ResetHandlerGroup = 'company_admin' | 'it_admin'

// How the request reaches the user.
//   'link' — an admin sends a one-time link from their queue. Everyone but the
//            IT Admin resets this way.
//   'otp'  — the IT Admin proves control of their mailbox with a 6-digit code and
//            serves themselves, because their own queue is the one they staff.
// Frozen on the row at request time, like handler_group, so the send path and the
// queue listing cannot disagree about which kind of request they are looking at.
export type ResetDeliveryMethod = 'link' | 'otp'

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
  delivery_method:  ResetDeliveryMethod
  status:           ResetRequestStatus
  token_hash:       string | null
  token_expires_at: string | null
  sent_by:          string | null
  sent_at:          string | null
  completed_at:     string | null
  requested_ip:     string | null
  last_notified_at: string | null
  // OTP path only; null on every 'link' row. otp_sent_at outlives the code being
  // spent or expiring, because it is what the resend cooldown is measured from.
  otp_hash:         string | null
  otp_expires_at:   string | null
  otp_attempts:     number
  otp_sent_at:      string | null
  created_at:       string
  updated_at:       string
}

// A queue row joined with the requester's name, for the admin table.
export interface PasswordResetQueueItem extends PasswordResetRequestRow {
  first_name: string | null
  last_name:  string | null
}
