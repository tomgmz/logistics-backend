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
  // Raised by a driver from the road, not by a workflow step. These carry
  // `report_id` in `data`; `booking_id` is set only when the driver was on a
  // delivery at the time, so a report raised in the yard leaves it null.
  | 'driver.emergency'                // quick alert or a report that stops the trip -> ops + fleet + admins
  | 'driver.report'                   // detailed report the trip survives -> ops + fleet + admins
  // Password resets. Scoped to a reset REQUEST, not a booking, so they carry
  // `request_id` in `data` and leave `booking_id` null. Routed to exactly one
  // admin group: driver/client requests to `admin` (Company Admin), staff
  // requests to `it_admin` — never both.
  | 'auth.password_reset_requested'   // user is locked out / forgot -> the owning admin group
  | 'auth.password_reset_completed'   // user set a new password -> the admin who sent the link

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
