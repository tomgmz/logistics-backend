import * as model from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import {
  CreateNotificationInput,
  NotificationRow,
  NotificationStage,
  NotificationType,
} from '../../types/notification.types.js'
import { BookingWithRelations } from '../../types/client/booking.types.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { formatManilaTimestamp, sendDeliveryConfirmEmail } from '../../lib/brevo-mailer.js'
import { logSystemError } from '../../lib/log-system.js'

// --- read-side pass-throughs ------------------------------------------------

export function listNotifications(userId: string, opts: { limit: number; before?: string | null }) {
  return model.listForUser(userId, opts)
}

export function pageNotifications(
  userId: string,
  opts: { page: number; limit: number; filter?: model.NotificationFilter | null },
) {
  return model.pageForUser(userId, opts)
}

export function getUnreadCount(userId: string) {
  return model.countUnread(userId)
}

// Whether a workflow stage is staffed (any active user with one of the roles).
export function hasActiveUsersWithRoles(roles: string[]) {
  return model.hasActiveUsersWithRoles(roles)
}

// Whether anyone can act on the GM approval stage — an active general manager
// or Company Administrator.
export async function hasGmApprovers(): Promise<boolean> {
  return (await model.resolveGmApprovers()).length > 0
}

// Whether this specific user may approve/reject on the GM stage.
export function isGmApprover(userId: string) {
  return model.isGmApprover(userId)
}

export function markRead(userId: string, notificationId: string) {
  return model.markRead(userId, notificationId)
}

export function markAllRead(userId: string) {
  return model.markAllRead(userId)
}

// --- stage configuration ----------------------------------------------------

interface StageConfig {
  type:  NotificationType
  // Roles that should be notified for staff stages. `admin` is the RBAC fallback
  // and is appended automatically, so it can be omitted here.
  roles?: string[]
  // For stages targeting the client, the assigned driver(s), or everyone who may
  // act on the GM approval stage (the general manager).
  audience?: 'client' | 'drivers' | 'gm_approvers'
  // Stages about a vehicle rather than an approval step deep-link the recipient
  // into Vehicle Management instead of Booking Management.
  target?: 'booking' | 'vehicle'
}

const STAGE_CONFIG: Record<NotificationStage, StageConfig> = {
  gm_pending:       { type: 'booking.gm_pending',       audience: 'gm_approvers' },
  rejected_gm:      { type: 'booking.rejected_gm',      audience: 'client' },
  rejected_admin:   { type: 'booking.rejected_admin',   audience: 'client' },
  // The other half of the decision: the client hears about an approval too, not
  // only about a rejection.
  approved_gm:      { type: 'booking.approved_gm',      audience: 'client' },
  approved_admin:   { type: 'booking.approved_admin',   audience: 'client' },
  ops_pending:      { type: 'booking.ops_pending',      roles: ['operations_manager'] },
  assigned:         { type: 'booking.assigned',         audience: 'drivers' },
  vehicle_assigned: { type: 'booking.vehicle_assigned', roles: ['fleet_manager'] },
  fleet_recheck:    { type: 'booking.fleet_recheck',    roles: ['fleet_manager'], target: 'vehicle' },
  // The driver confirmed the vehicle is back; its pass has expired and the Fleet
  // Manager (plus the Company Administrator, appended as always) must re-check it.
  vehicle_returned: { type: 'booking.vehicle_returned', roles: ['fleet_manager'], target: 'vehicle' },
  // The Fleet Manager pulled a vehicle that is on a live booking. Operations
  // (plus the Company Administrator) has to put another vehicle on it.
  vehicle_out_of_service: { type: 'booking.vehicle_out_of_service', roles: ['operations_manager'] },
  // Completion is the client's call once the driver is done.
  delivery_confirm:          { type: 'booking.delivery_confirm',          audience: 'client' },
  delivery_confirm_reminder: { type: 'booking.delivery_confirm_reminder', audience: 'client' },
  delivery_issue:            { type: 'booking.delivery_issue',            roles: ['operations_manager'] },
  delivery_issue_resolved:   { type: 'booking.delivery_issue_resolved',   audience: 'client' },
  // The office paused the delivery. The client is told the reason category
  // only; the note goes to the driver and the rest of the office.
  trip_paused:           { type: 'booking.trip_paused',           audience: 'client' },
  trip_paused_staff:     { type: 'booking.trip_paused_staff',     roles: ['operations_manager'] },
  trip_paused_by_staff:  { type: 'booking.trip_paused_by_staff',  audience: 'drivers' },
  trip_resumed:          { type: 'booking.trip_resumed',          audience: 'client' },
  trip_resumed_staff:    { type: 'booking.trip_resumed_staff',    roles: ['operations_manager'] },
  trip_resumed_by_staff: { type: 'booking.trip_resumed_by_staff', audience: 'drivers' },
  // The driver set off. Ops sees it live on the board; the client is told.
  delivery_started:      { type: 'booking.delivery_started',      audience: 'client' },
  // The office replaced the driver and/or vehicle of a delivery on the road. The
  // driver taken off is no longer on the crew, so they are named explicitly
  // (NotifyExtra.onlyUserIds); 'drivers' resolves to the crew now on it.
  crew_replaced_off:     { type: 'booking.crew_replaced_off',     audience: 'drivers' },
  crew_replaced_on:      { type: 'booking.crew_replaced_on',      audience: 'drivers' },
  crew_replaced_client:  { type: 'booking.crew_replaced_client',  audience: 'client' },
  crew_replaced_fleet:   { type: 'booking.crew_replaced_fleet',   roles: ['fleet_manager'], target: 'vehicle' },
}

// Route map per role so a notification tap lands on the right dashboard page.
const ROLE_PATHS: Record<string, string> = {
  general_manager:  '/general_manager/booking-management',
  operations_manager: '/operations_admin/booking-management',
  fleet_manager:      '/fleet_admin/booking-management',
  admin:            '/admin/booking-management',
  // Client rejection notifications open the booking in Transaction History (the
  // read view), not /client/booking which is the new-booking wizard.
  client:           '/client/history',
  driver:           '/driver/driver-assignment',
}

// Where a vehicle-centric notification lands. The fleet manager's BLOWBAGETS
// re-check is done in Vehicle Management, not on the booking.
const VEHICLE_PATHS: Record<string, string> = {
  fleet_manager: '/fleet_admin/vehicle-management',
  admin:         '/admin/vehicle-management',
}

// Deep-link a recipient to their own module page focused on the booking. The
// `?booking=` param is read by the web booking view (openDetail); mobile clients
// route off `data.booking_id` directly. Roles fall back to the admin page.
function actionUrlForRole(
  role: string,
  bookingId: string,
  target: 'booking' | 'vehicle' = 'booking',
): string {
  if (target === 'vehicle') {
    const base = VEHICLE_PATHS[role] ?? VEHICLE_PATHS.admin
    return `${base}?booking=${encodeURIComponent(bookingId)}`
  }
  const base = ROLE_PATHS[role] ?? ROLE_PATHS.admin
  return `${base}?booking=${encodeURIComponent(bookingId)}`
}

function bookingLabel(booking: BookingWithRelations): string {
  // Reference first, always. An address still beats a UUID in push copy, so it
  // keeps its place ahead of bookingRef()'s marked-id fallback.
  return booking.reference_number?.trim() || booking.origin || bookingRef(booking)
}

// What the client can do about a rejection, appended to both rejection messages.
const NEXT_STEP_AFTER_REJECTION = 'You can edit the booking and resubmit it for another review, or cancel it.'

function copyFor(
  stage: NotificationStage,
  booking: BookingWithRelations,
  extra?: NotifyExtra,
): { title: string; body: string } {
  const label  = bookingLabel(booking)
  const reason = extra?.reason
  switch (stage) {
    case 'gm_pending':
      // A rejected booking the client corrected comes back through this stage too.
      return (booking.resubmission_count ?? 0) > 0
        ? { title: 'Resubmitted booking awaiting your approval', body: `Booking ${label} was corrected and resubmitted by the client after being rejected, and needs your approval.` }
        : { title: 'New booking awaiting your approval', body: `Booking ${label} was submitted by the client and needs your approval.` }
    case 'rejected_gm':
      return { title: 'Booking rejected', body: `Your booking ${label} was rejected by the General Manager${reason ? `: ${reason}` : '.'} ${NEXT_STEP_AFTER_REJECTION}` }
    // Turned down by the administrator directly, without going to the GM.
    case 'rejected_admin':
      return { title: 'Booking rejected', body: `Your booking ${label} was not approved${reason ? `: ${reason}` : '.'} ${NEXT_STEP_AFTER_REJECTION}` }
    case 'approved_gm':
      return {
        title: 'Booking approved',
        body:  `Your booking ${label} was approved by the General Manager. We will let you know once a vehicle and driver are assigned.`,
      }
    case 'approved_admin':
      return {
        title: 'Booking approved',
        body:  `Your booking ${label} was approved by the Company Administrator. We will let you know once a vehicle and driver are assigned.`,
      }
    case 'ops_pending':
      return { title: 'Booking ready for assignment', body: `Booking ${label} was approved by the General Manager. Select a vehicle and driver.` }
    case 'assigned':
      return { title: 'New delivery assigned', body: `You have been assigned to booking ${label}.` }
    case 'vehicle_assigned':
      return {
        title: 'Vehicle assigned to a booking',
        body:  `${extra?.vehicleLabel ?? 'A vehicle'} was selected by the Operations Manager for booking ${label}.`,
      }
    case 'fleet_recheck':
      return {
        title: extra?.window === 'day_of' ? 'Re-check vehicle — dispatching today' : 'Re-check vehicle — dispatching tomorrow',
        body:  extra?.window === 'day_of'
          ? `Booking ${label} dispatches today. Run BLOWBAGETS on ${extra?.vehicleLabel ?? 'the assigned vehicle'} before it rolls out.`
          : `Booking ${label} dispatches tomorrow. Re-run BLOWBAGETS on ${extra?.vehicleLabel ?? 'the assigned vehicle'} so any fault can still be fixed.`,
      }
    case 'delivery_confirm':
      return {
        title: 'Delivery finished — please confirm',
        body:  `The driver has finished every drop-off for booking ${label}. Confirm it is complete, or report a problem. ` +
               'It completes automatically in 3 days if nothing is reported.',
      }
    case 'delivery_confirm_reminder':
      return {
        title: 'Booking completes tomorrow',
        body:  `Booking ${label} will be marked complete automatically tomorrow. Report a problem before then if something is wrong.`,
      }
    case 'delivery_issue':
      return {
        title: 'Client reported a problem with a delivery',
        body:  `The client reported a problem with booking ${label}${reason ? `: ${reason}` : '.'} ` +
               'It will not complete until you confirm it.',
      }
    case 'delivery_issue_resolved':
      return {
        title: 'Your reported problem was resolved',
        body:  `The problem you reported on booking ${label} was marked resolved. Confirm the booking is complete, ` +
               'or report a problem again if something is still wrong. It completes automatically in 3 days if nothing is reported.',
      }
    case 'vehicle_returned':
      return {
        title: 'Vehicle back — BLOWBAGETS re-check due',
        body:  `${extra?.vehicleLabel ?? 'The vehicle'} is back in the parking lot after booking ${label}. ` +
               'Record its return odometer; it cannot be assigned until that is in and it passes a new BLOWBAGETS inspection.',
      }
    case 'vehicle_out_of_service':
      return {
        title: 'Booking vehicle taken out of service',
        body:  extra?.onTheRoad
          ? `${extra?.vehicleLabel ?? 'The vehicle'} on booking ${label} was marked ${extra?.statusLabel ?? 'out of service'} while on the road. ` +
            'Decide whether to send a replacement vehicle.'
          : `${extra?.vehicleLabel ?? 'The vehicle'} on booking ${label} was marked ${extra?.statusLabel ?? 'out of service'}. ` +
            'Choose another vehicle before it is loaded.',
      }
    case 'trip_paused':
      return {
        title: 'Delivery paused',
        body:  `Your delivery ${label} is paused: ${extra?.pauseLabel ?? 'the truck had to stop'}. ` +
               'We will let you know as soon as it is moving again.',
      }
    case 'trip_paused_staff':
      return {
        title: `Delivery paused — ${extra?.pauseLabel ?? 'reason not given'}`,
        body:  `The office paused booking ${label}${reason ? `: ${reason}` : '.'}`,
      }
    case 'trip_paused_by_staff':
      return {
        title: `Delivery paused by the office — ${extra?.pauseLabel ?? 'reason not given'}`,
        body:  `Operations paused booking ${label}${reason ? `: ${reason}` : '.'} ` +
               'Wait until the office resumes it before continuing.',
      }
    case 'trip_resumed':
      return {
        title: 'Delivery moving again',
        body:  `Your delivery ${label} is on its way again.` +
               (extra?.newArrival ? ` New expected arrival: ${extra.newArrival}.` : ''),
      }
    case 'trip_resumed_staff':
      return {
        title: 'Delivery resumed',
        body:  `Booking ${label} is moving again` +
               (extra?.pausedFor ? ` after being paused for ${extra.pausedFor}.` : '.'),
      }
    case 'trip_resumed_by_staff':
      return {
        title: 'Your delivery was resumed by the office',
        body:  `Operations marked booking ${label} as moving again${reason ? `: ${reason}` : '.'}`,
      }
    case 'crew_replaced_off':
      return {
        title: 'You were taken off a delivery',
        body:  `The office handed booking ${label} to another ${extra?.swapped ?? 'driver'}${reason ? `: ${reason}` : '.'} ` +
               'You no longer need to continue it.',
      }
    case 'crew_replaced_on':
      return {
        title: `Continue delivery ${label}`,
        body:  extra?.transfer
          ? `Booking ${label} is yours to finish. First move the load from ${extra?.vehicleLabel ?? 'the old vehicle'} to your vehicle and confirm it with a photo, then continue to the remaining drop-offs.`
          : `Booking ${label} is yours to finish. Continue from where it stopped.`,
      }
    case 'crew_replaced_client':
      return {
        title: 'Your delivery continues',
        body:  `Your delivery ${label} continues with a new ${extra?.swapped ?? 'driver'}. We will keep you posted on the arrival time.`,
      }
    case 'crew_replaced_fleet':
      return {
        title: 'Vehicle replaced on the road',
        body:  `${extra?.vehicleLabel ?? 'A vehicle'} was replaced on booking ${label}${reason ? `: ${reason}` : '.'} ` +
               'It is no longer on the booking — set its status once it has been recovered or checked.',
      }
    case 'delivery_started':
      return {
        title: 'Your delivery is on its way',
        body:  `The driver has started booking ${label} and is heading to the pickup point. You can follow the truck live.`,
      }
  }
}

interface Recipient {
  user_id: string
  // The recipient's own role, used to deep-link them to their module page.
  role: string
}

async function resolveRecipients(stage: NotificationStage, booking: BookingWithRelations): Promise<Recipient[]> {
  const cfg = STAGE_CONFIG[stage]
  if (cfg.audience === 'client') {
    const uid = await model.resolveClientUserId(booking.client_id)
    return uid ? [{ user_id: uid, role: 'client' }] : []
  }
  if (cfg.audience === 'drivers') {
    const ids = await model.resolveDriverUserIds(booking.booking_id)
    return ids.map((user_id) => ({ user_id, role: 'driver' }))
  }
  if (cfg.audience === 'gm_approvers') {
    // The general manager, plus admins as the standing fallback.
    const approvers = await model.resolveGmApprovers()
    const admins    = await model.resolveRecipientsByRoles(['admin'])
    const byId      = new Map<string, Recipient>()
    for (const r of [...approvers, ...admins]) byId.set(r.user_id, r)
    return [...byId.values()]
  }
  // Staff stage: the responsible role plus admins (RBAC fallback). Roles are
  // kept per recipient so each lands on their own module page.
  const roles = [...new Set([...(cfg.roles ?? []), 'admin'])]
  return model.resolveRecipientsByRoles(roles)
}

export interface NotifyExtra {
  // Rejection remarks, surfaced to the client in the notification body.
  reason?:       string | null
  // Plate/model of the vehicle a fleet notification is about.
  vehicleLabel?: string | null
  // The vehicle's plate and the driver who drove it, shown as their own fields
  // (first) in the notification's details. Set by the vehicle re-check stages.
  plateNumber?:  string | null
  driverName?:   string | null
  // Which re-check nudge this is, for the `fleet_recheck` stage.
  window?:       'day_before' | 'day_of'
  // For `vehicle_out_of_service`: the status in words, and whether the vehicle
  // had already left with the cargo.
  statusLabel?:  string
  onTheRoad?:    boolean
  // For the pause stages: the reason category in words, and how long it lasted.
  pauseLabel?:   string
  pausedFor?:    string
  // For `trip_resumed`: the new expected arrival window, when a pause moved it
  // by 30 minutes or more.
  newArrival?:   string
  // Send to exactly these users (all drivers) instead of the stage's audience —
  // e.g. a driver who was just taken off the booking and so isn't on its crew.
  onlyUserIds?:  string[]
  // For the crew-replacement stages: what changed ('driver', 'vehicle',
  // 'driver and vehicle'), and whether the load has to be moved across.
  swapped?:      string
  transfer?:     boolean
}

/**
 * Fan out a workflow-stage notification: persist one row per recipient, push to
 * their devices, and broadcast a realtime event so open clients update live.
 * Best-effort — never throws into the caller's request path.
 */
export async function notifyStage(
  stage: NotificationStage,
  booking: BookingWithRelations,
  extra?: NotifyExtra,
): Promise<void> {
  // QA scripts that drive real services against the live database set this, so
  // a test run never pushes to real phones. Never set on a deployed server.
  if (process.env.SUPPRESS_NOTIFICATIONS === '1') return
  try {
    const recipients = extra?.onlyUserIds
      ? extra.onlyUserIds.map((user_id) => ({ user_id, role: 'driver' }))
      : await resolveRecipients(stage, booking)
    if (recipients.length === 0) return

    const cfg = STAGE_CONFIG[stage]
    const { title, body } = copyFor(stage, booking, extra)

    // Each recipient gets their own row + action_url so the tap deep-links them
    // to their own module page focused on this booking.
    const baseData = {
      // Ahead of the reference: the details list follows this order, and a
      // vehicle notification is acted on by plate and driver.
      ...(extra?.plateNumber ? { plate_number: extra.plateNumber } : {}),
      ...(extra?.driverName  ? { driver_name:  extra.driverName }  : {}),
      type:             cfg.type,
      stage,
      booking_id:       booking.booking_id,
      reference_number: booking.reference_number ?? null,
    }

    const rows: CreateNotificationInput[] = recipients.map(({ user_id, role }) => ({
      user_id,
      type:       cfg.type,
      title,
      body,
      booking_id: booking.booking_id,
      data:       { ...baseData, action_url: actionUrlForRole(role, booking.booking_id, cfg.target) },
    }))

    const inserted = await model.insertMany(rows)

    // Realtime: notify each recipient's personal channel with their own row.
    void Promise.allSettled(
      inserted.map((row: NotificationRow) =>
        broadcast(`notifications:user:${row.user_id}`, 'new_notification', row),
      ),
    )

    // Push fan-out (web + Expo). Group by action_url so each recipient's push
    // carries the deep-link into their own module page.
    const byUrl = new Map<string, string[]>()
    for (const { user_id, role } of recipients) {
      const url = actionUrlForRole(role, booking.booking_id, cfg.target)
      const list = byUrl.get(url)
      if (list) list.push(user_id)
      else byUrl.set(url, [user_id])
    }
    for (const [url, userIds] of byUrl) {
      void push.sendToUsers(userIds, {
        title,
        body,
        data: { ...baseData, action_url: url },
      })
    }
  } catch (err) {
    console.error('[notifications] notifyStage failed', stage, err)
  }
}

/**
 * Email the client that the driver is done and the booking needs their
 * confirmation — the email half of the `delivery_confirm` stage, so a client
 * who is not signed in still learns the auto-complete clock has started.
 * Best effort: a failed send is logged, never thrown into the driver's request.
 */
export async function emailDeliveryConfirm(
  booking: BookingWithRelations,
  autoCompleteDays: number,
): Promise<void> {
  try {
    const contact = await model.resolveClientContact(booking.client_id)
    if (!contact?.email) return

    // Sent right after markDelivered stamps delivered_at, so "now" is that moment
    // to within a second — the completion scheduler counts from the same instant.
    const completesAt = new Date(Date.now() + autoCompleteDays * 24 * 60 * 60 * 1000)

    await sendDeliveryConfirmEmail({
      to:             contact.email,
      firstName:      contact.first_name,
      bookingLabel:   bookingLabel(booking),
      autoCompleteOn: formatManilaTimestamp(completesAt.toISOString()),
      bookingId:      booking.booking_id,
    })
  } catch (err) {
    console.error('[notifications] delivery confirmation email failed', booking.booking_id, err)
    logSystemError('notification.service', 'email_event', err, { booking_id: booking.booking_id })
  }
}
