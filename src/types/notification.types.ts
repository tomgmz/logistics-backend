// In-app notification types for the booking approval workflow.
// Each stage transition emits one of these to a resolved set of recipients.

export type NotificationType =
  | 'booking.accounting_pending'   // new booking -> accountants + admins
  | 'booking.gm_pending'           // accounting approved/forwarded -> GMs + admins
  | 'booking.rejected_accounting'  // accounting rejected -> client
  | 'booking.ops_pending'          // GM approved -> ops + admins
  | 'booking.rejected_gm'          // GM rejected -> client
  | 'booking.fleet_pending'        // ops assigned -> fleet + admins
  | 'booking.fleet_rejected'       // fleet rejected (BLOWBAGETS) -> ops + admins
  | 'booking.assigned'             // fleet approved -> assigned driver(s)

export interface NotificationRow {
  notification_id: string
  user_id:         string
  type:            NotificationType
  title:           string
  body:            string
  booking_id:      string | null
  data:            Record<string, unknown>
  read_at:         string | null
  created_at:      string
}

export interface CreateNotificationInput {
  user_id:     string
  type:        NotificationType
  title:       string
  body:        string
  booking_id?: string | null
  data?:       Record<string, unknown>
}

// The approval stages that trigger a notification fan-out.
export type NotificationStage =
  | 'accounting_pending'
  | 'gm_pending'
  | 'rejected_accounting'
  | 'ops_pending'
  | 'rejected_gm'
  | 'fleet_pending'
  | 'fleet_rejected'
  | 'assigned'
