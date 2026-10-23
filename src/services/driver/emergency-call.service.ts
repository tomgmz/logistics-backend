import crypto from 'node:crypto'

import CallModel, { type EmergencyCall } from '../../models/driver/emergency-call.model.js'
import ReportModel from '../../models/driver/report.model.js'
import * as notificationModel from '../../models/notification/notification.model.js'
import * as push from '../messaging/push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { logEvent } from '../../lib/log-event.js'
import { isLiveKitConfigured, liveKitUrl, mintRoomToken, closeRoom } from '../../lib/livekit.js'
import { logSystemThrottled } from '../../lib/log-system.js'
import type { DriverReport, IncidentType } from '../../types/driver/report.types.js'

/**
 * The in-app voice call a driver places after a quick alert.
 *
 * Simulring: every active Operations Manager's browser rings at once. Company
 * Administrators are rung only when there are no active Operations Managers at
 * all. The first one to press Answer gets the call (`CallModel.claim`), and the
 * others' ringers are told to stop.
 *
 * The phone owns the fallback. It rings for RING_SECONDS, and if nobody picks up
 * (or the call can't connect) it closes the call as 'fell_back' and dials out
 * through its own dialer. The server only times out calls the phone abandoned
 * without saying so.
 */

export const RING_SECONDS = 60
/** Server-side cut-off for a ringing call the phone never closed. */
const STALE_RING_MS = (RING_SECONDS + 30) * 1000

/** Staff browsers listen on this topic for incoming calls. */
const callTopic = (userId: string) => `calls:user:${userId}`

const INCIDENT_LABEL: Record<IncidentType, string> = {
  accident:          'Accident',
  vehicle_breakdown: 'Vehicle breakdown',
  health_emergency:  'Health emergency',
  security_threat:   'Security threat',
}

export class CallError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

/** What a ringing browser shows: who is calling, from where, about what. */
export interface IncomingCall {
  call_id:       string
  report_id:     string | null
  booking_id:    string | null
  booking_ref:   string | null
  driver_name:   string
  driver_phone:  string | null
  plate_number:  string | null
  incident:      string
  latitude:      number | null
  longitude:     number | null
  address:       string | null
  speed_kmh:     number | null
  created_at:    string
}

function fullName(u?: { first_name: string | null; last_name: string | null } | null): string {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim()
}

function toIncoming(call: EmergencyCall, report: DriverReport | null): IncomingCall {
  return {
    call_id:      call.call_id,
    report_id:    call.report_id,
    booking_id:   call.booking_id,
    booking_ref:  report?.bookings?.reference_number ?? null,
    driver_name:  fullName(report?.drivers?.users) || 'Driver',
    driver_phone: report?.drivers?.users?.phone ?? null,
    plate_number: report?.trucks?.plate_number ?? null,
    incident:     report?.incident_type ? INCIDENT_LABEL[report.incident_type] : 'Unspecified emergency',
    latitude:     report?.latitude  != null ? Number(report.latitude)  : null,
    longitude:    report?.longitude != null ? Number(report.longitude) : null,
    address:      report?.address ?? null,
    speed_kmh:    report?.speed_kmh != null ? Number(report.speed_kmh) : null,
    created_at:   call.created_at,
  }
}

/** Operations Managers, or Company Administrators when there are none. */
async function ringTargets(): Promise<string[]> {
  const managers = await notificationModel.resolveUserIdsByRoles(['operations_manager'])
  if (managers.length > 0) return managers
  return notificationModel.resolveUserIdsByRoles(['admin'])
}

function tellRung(call: EmergencyCall, event: string, payload: unknown, except?: string | null) {
  void Promise.allSettled(
    call.rung_user_ids
      .filter((id) => id !== except)
      .map((id) => broadcast(callTopic(id), event, payload)),
  )
}

/* ── Driver side ──────────────────────────────────────────────────────────── */

export async function startCallService(
  driverId: string,
  driverUserId: string,
  reportId: string,
): Promise<{ call_id: string; url: string; token: string; ring_seconds: number }> {
  if (!isLiveKitConfigured()) {
    // Drivers still get through by phone, but IT should know the in-app path is off.
    logSystemThrottled('livekit.config', 60 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'livekit.config',
      message:    'A driver tried an emergency call but LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set; the phone fell back to a normal call.',
    })
    throw new CallError('In-app calling is not set up', 503)
  }

  const report = await ReportModel.findByIdForStaff(reportId)
  if (!report || report.driver_id !== driverId) throw new CallError('Report not found', 404)

  const rung = await ringTargets()
  if (rung.length === 0) throw new CallError('There is nobody to ring', 409)

  const call = await CallModel.create({
    report_id:     report.report_id,
    driver_id:     driverId,
    booking_id:    report.booking_id,
    room_name:     `emergency-${crypto.randomUUID()}`,
    rung_user_ids: rung,
  })

  const token = await mintRoomToken({
    room:     call.room_name,
    identity: `driver:${driverUserId}`,
    name:     fullName(report.drivers?.users) || 'Driver',
  })

  const incoming = toIncoming(call, report)
  tellRung(call, 'incoming_call', incoming)

  // A push too, for a manager whose dashboard tab is closed: opening it lands
  // on the report, where the ringer picks the call up if it is still ringing.
  void push.sendToUsers(rung, {
    title: `EMERGENCY CALL — ${incoming.driver_name}${incoming.plate_number ? ` · ${incoming.plate_number}` : ''}`,
    body:  `${incoming.incident}. Open the dashboard to answer.`,
    data:  { type: 'driver.emergency_call', call_id: call.call_id, report_id: call.report_id },
    tag:   `call-${call.call_id}`,
  })

  logEvent({
    user_id:     driverUserId,
    log_type:    'vehicle_activity',
    action:      'driver_emergency_call',
    description: `Driver placed an in-app emergency call; ${rung.length} staff rung`,
  })

  // Close it on the server if the phone vanishes without closing it itself.
  setTimeout(() => { void expireIfStillRinging(call.call_id) }, STALE_RING_MS).unref?.()

  return { call_id: call.call_id, url: liveKitUrl(), token, ring_seconds: RING_SECONDS }
}

async function expireIfStillRinging(callId: string) {
  try {
    // Ringing only: an answered call is live and must not be cut off.
    const closed = await CallModel.close(callId, 'missed', 'timeout', null, ['ringing'])
    if (!closed) return
    tellRung(closed, 'call_closed', { call_id: callId, reason: 'timeout' })
    void closeRoom(closed.room_name)
  } catch (e: any) {
    console.warn('[calls] could not expire call', callId, e?.message)
  }
}

/**
 * The driver hung up, nobody answered, or the call fell back to the dialer.
 */
export async function endCallAsDriverService(
  driverId: string,
  driverUserId: string,
  callId: string,
  reason: 'hangup' | 'no_answer' | 'failed' | 'fell_back',
  detail?: string,
): Promise<void> {
  const call = await CallModel.findById(callId)
  if (!call || call.driver_id !== driverId) throw new CallError('Call not found', 404)

  const status =
    call.status === 'answered' ? 'ended'
    : reason === 'fell_back' || reason === 'no_answer' || reason === 'failed' ? 'fell_back'
    : 'missed'

  const closed = await CallModel.close(callId, status, reason, driverUserId)
  if (!closed) return // already closed — nothing to tell anyone

  if (reason === 'failed') {
    // Console every time; the dashboard row below is throttled.
    console.warn('[calls] driver could not connect', callId, detail ?? '(no detail)')
    // The phone could not connect to the LiveKit room at all.
    logSystemThrottled('livekit.connect', 10 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'livekit.connect',
      message:    `A driver could not connect the in-app emergency call and fell back to a phone call.${detail ? ` (${detail})` : ''}`,
      metadata:   { call_id: callId, detail: detail ?? null },
    })
  }

  tellRung(closed, 'call_closed', { call_id: callId, reason })
  void closeRoom(closed.room_name)
}

/* ── Staff side ───────────────────────────────────────────────────────────── */

/** Calls ringing for this manager right now — for a dashboard that just opened. */
export async function ringingForService(userId: string): Promise<IncomingCall[]> {
  const calls = await CallModel.findRingingFor(userId, new Date(Date.now() - STALE_RING_MS))
  return Promise.all(
    calls.map(async (c) => toIncoming(c, c.report_id ? await ReportModel.findByIdForStaff(c.report_id) : null)),
  )
}

export async function answerCallService(
  callId: string,
  user: { userId: string; name: string },
): Promise<{ url: string; token: string; call: IncomingCall }> {
  if (!isLiveKitConfigured()) throw new CallError('In-app calling is not set up', 503)

  const existing = await CallModel.findById(callId)
  if (!existing || !existing.rung_user_ids.includes(user.userId)) throw new CallError('Call not found', 404)

  const call = await CallModel.claim(callId, user.userId)
  if (!call) {
    throw new CallError(
      existing.status === 'answered' ? 'Someone else already answered this call' : 'This call has ended',
      409,
    )
  }

  // Everyone else stops ringing.
  tellRung(call, 'call_taken', { call_id: callId, answered_by_name: user.name }, user.userId)

  const report = call.report_id ? await ReportModel.findByIdForStaff(call.report_id) : null
  const token  = await mintRoomToken({
    room:     call.room_name,
    identity: `staff:${user.userId}`,
    name:     user.name,
  })

  logEvent({
    user_id:     user.userId,
    log_type:    'vehicle_activity',
    action:      'emergency_call_answered',
    description: `Answered the driver's emergency call`,
  })

  return { url: liveKitUrl(), token, call: toIncoming(call, report) }
}

export async function endCallAsStaffService(callId: string, userId: string): Promise<void> {
  const call = await CallModel.findById(callId)
  if (!call || call.answered_by !== userId) throw new CallError('Call not found', 404)

  const closed = await CallModel.close(callId, 'ended', 'hangup', userId)
  if (!closed) return
  void closeRoom(closed.room_name)
}
