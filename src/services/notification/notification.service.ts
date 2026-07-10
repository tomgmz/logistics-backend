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
  // For stages targeting the client or the assigned driver(s) instead of a role.
  audience?: 'client' | 'drivers'
}

const STAGE_CONFIG: Record<NotificationStage, StageConfig> = {
  accounting_pending:  { type: 'booking.accounting_pending',  roles: ['accountant'] },
  gm_pending:          { type: 'booking.gm_pending',          roles: ['general_manager'] },
  rejected_accounting: { type: 'booking.rejected_accounting', audience: 'client' },
  ops_pending:         { type: 'booking.ops_pending',         roles: ['operations_manager'] },
  rejected_gm:         { type: 'booking.rejected_gm',         audience: 'client' },
  fleet_pending:       { type: 'booking.fleet_pending',       roles: ['fleet_manager'] },
  fleet_rejected:      { type: 'booking.fleet_rejected',      roles: ['operations_manager'] },
  assigned:            { type: 'booking.assigned',            audience: 'drivers' },
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

// Deep-link a recipient to their own module page focused on the booking. The
// `?booking=` param is read by the web booking view (openDetail); mobile clients
// route off `data.booking_id` directly. Roles fall back to the admin page.
function actionUrlForRole(role: string, bookingId: string): string {
  const base = ROLE_PATHS[role] ?? ROLE_PATHS.admin
  return `${base}?booking=${encodeURIComponent(bookingId)}`
}

function bookingLabel(booking: BookingWithRelations): string {
  return booking.reference_number || booking.origin || `#${booking.booking_id.slice(0, 8)}`
}

function copyFor(
  stage: NotificationStage,
  booking: BookingWithRelations,
  reason?: string | null,
): { title: string; body: string } {
  const label = bookingLabel(booking)
  switch (stage) {
    case 'accounting_pending':
      return { title: 'New booking to review', body: `Booking ${label} needs an accounting profitability check.` }
    case 'gm_pending':
      return { title: 'Booking awaiting your approval', body: `Booking ${label} passed accounting and needs the GM's final say.` }
    case 'rejected_accounting':
      return { title: 'Booking rejected', body: `Your booking ${label} was rejected by accounting${reason ? `: ${reason}` : '.'}` }
    case 'ops_pending':
      return { title: 'Booking ready for assignment', body: `Booking ${label} was approved. Assign vehicle(s) and driver(s).` }
    case 'rejected_gm':
      return { title: 'Booking rejected', body: `Your booking ${label} was rejected by the general manager${reason ? `: ${reason}` : '.'}` }
    case 'fleet_pending':
      return { title: 'Vehicle check needed', body: `Booking ${label} has assignments. Run the BLOWBAGETS check before dispatch.` }
    case 'fleet_rejected':
      return { title: 'Vehicle rejected — reassign', body: `Fleet rejected the vehicle for booking ${label}${reason ? `: ${reason}` : '.'} Please assign another.` }
    case 'assigned':
      return { title: 'New delivery assigned', body: `You have been assigned to booking ${label}.` }
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
  // Staff stage: the responsible role plus admins (RBAC fallback). Roles are
  // kept per recipient so each lands on their own module page.
  const roles = [...new Set([...(cfg.roles ?? []), 'admin'])]
  return model.resolveRecipientsByRoles(roles)
}

/**
 * Fan out a workflow-stage notification: persist one row per recipient, push to
 * their devices, and broadcast a realtime event so open clients update live.
 * Best-effort — never throws into the caller's request path.
 */
export async function notifyStage(
  stage: NotificationStage,
  booking: BookingWithRelations,
  extra?: { reason?: string | null },
): Promise<void> {
  try {
    const recipients = await resolveRecipients(stage, booking)
    if (recipients.length === 0) return

    const cfg = STAGE_CONFIG[stage]
    const { title, body } = copyFor(stage, booking, extra?.reason)

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
      data:       { ...baseData, action_url: actionUrlForRole(role, booking.booking_id) },
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
      const url = actionUrlForRole(role, booking.booking_id)
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
