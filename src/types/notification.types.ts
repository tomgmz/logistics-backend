// In-app notification types for the booking approval workflow.
// Each stage transition emits one of these to a resolved set of recipients.
//
// The live workflow is GM-first: client books -> GM approves -> operations picks
// a vehicle + driver -> the driver is told about the delivery and the fleet
// manager is told one of their vehicles was taken.

export type NotificationType =
  | 'booking.gm_pending'           // new booking -> GMs (+ GM proxies) + admins
  | 'booking.rejected_gm'          // GM rejected -> client
  | 'booking.rejected_admin'       // admin rejected outright -> client
  | 'booking.ops_pending'          // GM approved -> ops + admins
  | 'booking.assigned'             // ops assigned -> assigned driver(s)
  | 'booking.vehicle_assigned'     // ops assigned -> fleet + admins (informational)
  | 'booking.fleet_recheck'        // scheduled BLOWBAGETS re-check -> fleet + admins
  // Legacy types, still present on historical rows. No longer emitted: accounting
  // was removed from the chain and the fleet stage no longer gates dispatch.
  | 'booking.accounting_pending'
  | 'booking.rejected_accounting'
  | 'booking.fleet_pending'
  | 'booking.fleet_rejected'
  // Reverse billing. These are scoped to a billing PERIOD, not a booking, so
  // they carry `period_id` in `data` and leave `booking_id` null. The CHECK
  // constraint on notifications.type was dropped in the create migration, so no
  // schema change is needed to add values here.
  | 'billing.summary_sent'            // weekly: 8338 sent the summary -> client
  | 'billing.summary_approved'        // weekly: client approved -> accountant + admins
  | 'billing.summary_rejected'        // weekly: client rejected -> accountant + admins
  | 'billing.review_lapsed'           // weekly: 3-day window passed -> accountant + admins
  | 'billing.submission_window_open'  // monthly: window opened -> client
  | 'billing.submitted'               // monthly: client submitted -> accountant + admins
  | 'billing.submission_accepted'     // monthly: 8338 validated -> client
  | 'billing.submission_rejected'     // monthly: figures disagreed -> client, resubmit
  | 'billing.rolled_over'             // monthly: window missed -> client + accountant
  | 'billing.invoice_issued'          // Service Invoice issued -> client
  | 'billing.payment_due'             // due Friday reached -> client
  | 'billing.payment_overdue'         // past the due Friday -> client + accountant
  | 'billing.payment_recorded'        // payment logged -> client
  | 'billing.receipt_issued'          // Acknowledgement Receipt issued -> client

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
  | 'gm_pending'
  | 'rejected_gm'
  | 'rejected_admin'
  | 'ops_pending'
  | 'assigned'
  | 'vehicle_assigned'
  | 'fleet_recheck'
