import * as model from '../../models/notification/notification.model.js'
import { broadcast } from '../../lib/realtime.js'
import { sendToUsers } from '../messaging/push.service.js'
import type { CreateNotificationInput, NotificationRow, NotificationType } from '../../types/notification.types.js'
import type { BillingPeriod } from '../../types/billing.types.js'
import { formatPeso } from '../../lib/billing-amounts.js'

/**
 * Notification fan-out for reverse billing.
 *
 * Parallel to notifyStage() rather than folded into it: that helper is built
 * around a booking and resolves recipients from a booking's driver and client,
 * whereas everything here is scoped to a billing PERIOD and often has no
 * booking at all. Sharing the notification MODEL keeps the storage, push and
 * realtime behaviour identical without bending a booking-shaped API around a
 * period-shaped event.
 *
 * Best effort throughout: a billing action must never fail because a push
 * token expired.
 */

/** Staff who deal with billing. Admins are always included as an RBAC fallback. */
const BILLING_STAFF_ROLES = ['accountant', 'general_manager', 'admin']

type Audience = 'client' | 'staff' | 'both'

interface BillingNotice {
  type: NotificationType
  audience: Audience
  title: string
  body: string
}

/** Where a recipient should land when they tap the notification. */
function actionUrlForRole(role: string, periodId: string): string {
  if (role === 'client') return `/client/reverse-billing?period=${periodId}`
  if (role === 'accountant') return `/accountant/billing-management?period=${periodId}`
  if (role === 'general_manager') return `/general_manager/billing-management?period=${periodId}`
  return `/admin/billing-management?period=${periodId}`
}

/** A period's human label, e.g. "Mar 01–15, 2026" or "Mar 23–31, 2026". */
export function periodLabel(period: Pick<BillingPeriod, 'period_start' | 'period_end'>): string {
  const fmt = (d: string, withYear = false) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString('en-PH', {
      month: 'short',
      day: '2-digit',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    })
  return `${fmt(period.period_start)}–${fmt(period.period_end, true)}`
}

export async function notifyBilling(
  notice: BillingNotice,
  period: BillingPeriod,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const recipients: { user_id: string; role: string }[] = []

    if (notice.audience === 'client' || notice.audience === 'both') {
      const clientUserId = await model.resolveClientUserId(period.client_id)
      if (clientUserId) recipients.push({ user_id: clientUserId, role: 'client' })
    }
    if (notice.audience === 'staff' || notice.audience === 'both') {
      recipients.push(...(await model.resolveRecipientsByRoles(BILLING_STAFF_ROLES)))
    }

    // The same person can hold two roles; one notification each.
    const unique = new Map(recipients.map((r) => [r.user_id, r]))
    if (unique.size === 0) return

    const baseData = {
      type: notice.type,
      period_id: period.period_id,
      mode: period.mode,
      period_start: period.period_start,
      period_end: period.period_end,
      ...extra,
    }

    const rows: CreateNotificationInput[] = [...unique.values()].map(({ user_id, role }) => ({
      user_id,
      type: notice.type,
      title: notice.title,
      body: notice.body,
      // Billing is period-scoped; there is no single booking behind it.
      booking_id: null,
      data: { ...baseData, action_url: actionUrlForRole(role, period.period_id) },
    }))

    const inserted = await model.insertMany(rows)

    void Promise.allSettled(
      inserted.map((row: NotificationRow) =>
        broadcast(`notifications:user:${row.user_id}`, 'new_notification', row),
      ),
    )
    void sendToUsers([...unique.keys()], {
      title: notice.title,
      body: notice.body,
      data: baseData,
    }).catch(() => {})
  } catch (err) {
    console.error('[notifyBilling]', (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// The copy for each event, in one place so the wording stays consistent.
// ---------------------------------------------------------------------------

export const BillingNotices = {
  summarySent: (p: BillingPeriod): BillingNotice => ({
    type: 'billing.summary_sent',
    audience: 'client',
    title: 'Billing summary ready for review',
    body: `8338 has sent your billing summary for ${periodLabel(p)} (${formatPeso(p.total_amount)}). Please review and approve it within 3 working days.`,
  }),

  summaryApproved: (p: BillingPeriod): BillingNotice => ({
    type: 'billing.summary_approved',
    audience: 'staff',
    title: 'Client approved a billing summary',
    body: `The billing summary for ${periodLabel(p)} was approved. A Service Invoice can now be issued.`,
  }),

  summaryRejected: (p: BillingPeriod, reason?: string | null): BillingNotice => ({
    type: 'billing.summary_rejected',
    audience: 'staff',
    title: 'Client rejected a billing summary',
    body: `The billing summary for ${periodLabel(p)} was rejected and needs revising.${reason ? ` Reason: ${reason}` : ''}`,
  }),

  reviewLapsed: (p: BillingPeriod): BillingNotice => ({
    type: 'billing.review_lapsed',
    audience: 'staff',
    // The contract is explicit that nothing auto-approves: 8338 follows up.
    title: 'Billing review window lapsed',
    body: `The client has not responded to the ${periodLabel(p)} billing summary within 3 working days. Follow up for approval.`,
  }),

  submissionWindowOpen: (p: BillingPeriod): BillingNotice => ({
    type: 'billing.submission_window_open',
    audience: 'client',
    title: 'Reverse billing submission is now open',
    body: `Submit your billing summary for ${periodLabel(p)} between ${p.submission_start} and ${p.submission_end}. Late submissions move to the next cut-off.`,
  }),

  submitted: (p: BillingPeriod, amount: number | null): BillingNotice => ({
    type: 'billing.submitted',
    audience: 'staff',
    title: 'Client submitted a reverse billing',
    body: `A reverse billing for ${periodLabel(p)}${amount !== null ? ` of ${formatPeso(amount)}` : ''} is waiting to be cross-checked.`,
  }),

  submissionAccepted: (p: BillingPeriod): BillingNotice => ({
    type: 'billing.submission_accepted',
    audience: 'client',
    title: 'Reverse billing validated',
    body: `Your reverse billing for ${periodLabel(p)} checked out. 8338 will issue the Service Invoice.`,
  }),

  submissionRejected: (p: BillingPeriod, reason?: string | null): BillingNotice => ({
    type: 'billing.submission_rejected',
    audience: 'client',
    title: 'Reverse billing needs correcting',
    body: `Your reverse billing for ${periodLabel(p)} did not match 8338's records.${reason ? ` ${reason}` : ''} Please resubmit.`,
  }),

  rolledOver: (p: BillingPeriod): BillingNotice => ({
    type: 'billing.rolled_over',
    audience: 'both',
    title: 'Billing moved to the next cut-off',
    body: `No reverse billing was submitted for ${periodLabel(p)} within the window, so it moves to the next cut-off cycle. The payment date shifts with it.`,
  }),

  invoiceIssued: (p: BillingPeriod, siNumber: string, total: number, dueDate: string): BillingNotice => ({
    type: 'billing.invoice_issued',
    audience: 'client',
    title: `Service Invoice ${siNumber} issued`,
    body: `${formatPeso(total)} for ${periodLabel(p)}. Payment is due ${dueDate}, a Friday — 8338 only accepts payment on Fridays.`,
  }),

  paymentDue: (p: BillingPeriod, siNumber: string, total: number): BillingNotice => ({
    type: 'billing.payment_due',
    audience: 'client',
    title: `Payment due today for ${siNumber}`,
    body: `${formatPeso(total)} for ${periodLabel(p)} is due today.`,
  }),

  paymentOverdue: (p: BillingPeriod, siNumber: string, dueDate: string): BillingNotice => ({
    type: 'billing.payment_overdue',
    audience: 'both',
    title: `Service Invoice ${siNumber} is overdue`,
    body: `Payment for ${periodLabel(p)} was due ${dueDate} and has not been recorded.`,
  }),

  paymentRecorded: (p: BillingPeriod, amount: number): BillingNotice => ({
    type: 'billing.payment_recorded',
    audience: 'client',
    title: 'Payment received',
    body: `8338 recorded your payment of ${formatPeso(amount)} for ${periodLabel(p)}. An Acknowledgement Receipt will follow.`,
  }),

  receiptIssued: (p: BillingPeriod, arNumber: string): BillingNotice => ({
    type: 'billing.receipt_issued',
    audience: 'client',
    title: `Acknowledgement Receipt ${arNumber} issued`,
    body: `Your billing cycle for ${periodLabel(p)} is now closed. A hard copy will follow.`,
  }),
}
