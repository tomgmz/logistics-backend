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

// --- read-side pass-throughs ------------------------------------------------

export function listNotifications(userId: string, opts: { limit: number; before?: string | null }) {
  return model.listForUser(userId, opts)
}

export function getUnreadCount(userId: string) {
  return model.countUnread(userId)
}

// Whether a workflow stage is staffed (any active user with one of the roles).
export function hasActiveUsersWithRoles(roles: string[]) {
  return model.hasActiveUsersWithRoles(roles)
}

// Whether anyone can act on the GM approval stage — a general manager or an
// accountant the IT admin appointed as GM proxy.
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
  // act on the GM approval stage (the GM plus any appointed proxy).
  audience?: 'client' | 'drivers' | 'gm_approvers'
  // Stages about a vehicle rather than an approval step deep-link the recipient
  // into Vehicle Management instead of Booking Management.
  target?: 'booking' | 'vehicle'
}

const STAGE_CONFIG: Record<NotificationStage, StageConfig> = {
  gm_pending:       { type: 'booking.gm_pending',       audience: 'gm_approvers' },
  rejected_gm:      { type: 'booking.rejected_gm',      audience: 'client' },
  rejected_admin:   { type: 'booking.rejected_admin',   audience: 'client' },
  ops_pending:      { type: 'booking.ops_pending',      roles: ['operations_manager'] },
  assigned:         { type: 'booking.assigned',         audience: 'drivers' },
  vehicle_assigned: { type: 'booking.vehicle_assigned', roles: ['fleet_manager'] },
  fleet_recheck:    { type: 'booking.fleet_recheck',    roles: ['fleet_manager'], target: 'vehicle' },
}

// Route map per role so a notification tap lands on the right dashboard page.
const ROLE_PATHS: Record<string, string> = {
  accountant:       '/accountant/booking-management',
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

function copyFor(
  stage: NotificationStage,
  booking: BookingWithRelations,
  extra?: NotifyExtra,
): { title: string; body: string } {
  const label  = bookingLabel(booking)
  const reason = extra?.reason
  switch (stage) {
    case 'gm_pending':
      return { title: 'New booking awaiting your approval', body: `Booking ${label} was submitted by the client and needs your approval.` }
    case 'rejected_gm':
      return { title: 'Booking rejected', body: `Your booking ${label} was rejected by the general manager${reason ? `: ${reason}` : '.'}` }
    // Turned down by the administrator directly, without going to the GM.
    case 'rejected_admin':
      return { title: 'Booking rejected', body: `Your booking ${label} was not approved${reason ? `: ${reason}` : '.'}` }
    case 'ops_pending':
      return { title: 'Booking ready for assignment', body: `Booking ${label} was approved by the GM. Select a vehicle and driver.` }
    case 'assigned':
      return { title: 'New delivery assigned', body: `You have been assigned to booking ${label}.` }
    case 'vehicle_assigned':
      return {
        title: 'Vehicle assigned to a booking',
        body:  `${extra?.vehicleLabel ?? 'A vehicle'} was selected by operations for booking ${label}.`,
      }
    case 'fleet_recheck':
      return {
        title: extra?.window === 'day_of' ? 'Re-check vehicle — dispatching today' : 'Re-check vehicle — dispatching tomorrow',
        body:  extra?.window === 'day_of'
          ? `Booking ${label} dispatches today. Run BLOWBAGETS on ${extra?.vehicleLabel ?? 'the assigned vehicle'} before it rolls out.`
          : `Booking ${label} dispatches tomorrow. Re-run BLOWBAGETS on ${extra?.vehicleLabel ?? 'the assigned vehicle'} so any fault can still be fixed.`,
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
    // The GM plus any appointed proxy, plus admins as the standing fallback.
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
  // Which re-check nudge this is, for the `fleet_recheck` stage.
  window?:       'day_before' | 'day_of'
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
  try {
    const recipients = await resolveRecipients(stage, booking)
    if (recipients.length === 0) return

    const cfg = STAGE_CONFIG[stage]
    const { title, body } = copyFor(stage, booking, extra)

    // Each recipient gets their own row + action_url so the tap deep-links them
    // to their own module page focused on this booking.
    const baseData = {
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
