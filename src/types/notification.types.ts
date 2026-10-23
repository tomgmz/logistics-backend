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
  | 'booking.approved_gm'          // GM approved -> client
  | 'booking.approved_admin'       // admin approved on their own authority -> client
  | 'booking.ops_pending'          // GM approved -> ops + admins
  | 'booking.assigned'             // ops assigned -> assigned driver(s)
  | 'booking.vehicle_assigned'     // ops assigned -> fleet + admins (informational)
  | 'booking.fleet_recheck'        // scheduled BLOWBAGETS re-check -> fleet + admins
  | 'booking.vehicle_returned'     // vehicle back in the lot, re-check due -> fleet + admins
  | 'booking.vehicle_out_of_service' // vehicle on a live booking taken out of service -> ops + admins
  | 'booking.delivery_confirm'     // driver finished -> client, please confirm or report a problem
  | 'booking.delivery_confirm_reminder' // day before auto-complete -> client
  | 'booking.delivery_issue'       // client reported a problem -> ops + admins
  | 'booking.delivery_issue_resolved' // staff resolved it, 3 days restart -> client
  | 'booking.trip_paused'          // office paused the delivery -> client (reason only)
  | 'booking.trip_paused_staff'    // office paused the delivery -> ops + admins (with the note)
  | 'booking.trip_paused_by_staff' // office paused the delivery -> assigned driver(s) (with the note)
  | 'booking.trip_resumed'         // delivery moving again -> client
  | 'booking.trip_resumed_staff'   // pause ended -> ops + admins
  | 'booking.trip_resumed_by_staff' // the office ended the pause -> assigned driver(s)
  | 'booking.delivery_started'     // driver started navigation, booking in transit -> client
  | 'booking.crew_replaced_off'    // office replaced the crew on the road -> the driver taken off
  | 'booking.crew_replaced_on'     // ... -> the crew now on it (continue where it stopped)
  | 'booking.crew_replaced_client' // ... -> client
  | 'booking.crew_replaced_fleet'  // the vehicle was swapped -> fleet + admins (the old one is out there)
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
  // Scheduled, about the driver themselves: their license expires within a month.
  // Carries `license_expiry` in `data`; `booking_id` is always null.
  | 'driver.license_expiring'         // one month before license_expiry -> that driver
  // Password resets. Scoped to a reset REQUEST, not a booking, so they carry
  // `request_id` in `data` and leave `booking_id` null. Routed to exactly one
  // admin group: driver/client requests to `admin` (Company Admin), staff
  // requests to `it_admin` — never both.
  | 'auth.password_reset_requested'   // user is locked out / forgot -> the owning admin group
  | 'auth.password_reset_completed'   // user set a new password -> the admin who sent the link
  // Client support tickets. Carry `ticket_id` + `reference_number` in `data`;
  // `booking_id` stays null even when the ticket names a booking.
  | 'support.ticket_opened'           // client opened a ticket -> Company Administrators
  | 'support.ticket_resolved'         // staff resolved it -> the client who opened it

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
  | 'approved_gm'
  | 'approved_admin'
  | 'ops_pending'
  | 'assigned'
  | 'vehicle_assigned'
  | 'fleet_recheck'
  | 'vehicle_returned'
  | 'vehicle_out_of_service'
  | 'delivery_confirm'
  | 'delivery_confirm_reminder'
  | 'delivery_issue'
  | 'delivery_issue_resolved'
  | 'trip_paused'
  | 'trip_paused_staff'
  | 'trip_paused_by_staff'
  | 'trip_resumed'
  | 'trip_resumed_staff'
  | 'trip_resumed_by_staff'
  | 'delivery_started'
  | 'crew_replaced_off'
  | 'crew_replaced_on'
  | 'crew_replaced_client'
  | 'crew_replaced_fleet'
