import crypto from 'node:crypto'

import CallModel, { type ChatCall } from '../../models/messaging/chat-call.model.js'
import * as model from '../../models/messaging/messaging.model.js'
import * as push from './push.service.js'
import { broadcast } from '../../lib/realtime.js'
import { isLiveKitConfigured, liveKitUrl, mintRoomToken, closeRoom, roomParticipantCount } from '../../lib/livekit.js'
import { logSystemThrottled } from '../../lib/log-system.js'

/**
 * A voice call between the two people in a direct conversation.
 *
 * The caller places it and joins the LiveKit room straight away; the callee's
 * browsers and phone ring on `chat-calls:user:{id}` (plus a push for a closed
 * tab). The callee answers or declines; either end hangs up. The caller owns
 * the ring timeout: after RING_SECONDS it closes the call as missed. The server
 * only times out calls the caller abandoned without saying so.
 *
 * Clients are never on either end of a call. They message, they don't call.
 */

export const RING_SECONDS = 45
/** Server-side cut-off for a ringing call the caller never closed. */
const STALE_RING_MS = (RING_SECONDS + 30) * 1000

/** Browsers and phones listen on this topic for chat calls. */
const callTopic = (userId: string) => `chat-calls:user:${userId}`

export class ChatCallError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

/** A call as either end shows it: who is on the other side. */
export interface ChatCallView {
  call_id:         string
  conversation_id: string
  caller_id:       string
  caller_name:     string
  caller_role:     string
  callee_id:       string
  callee_name:     string
  callee_role:     string
  status:          ChatCall['status']
  created_at:      string
}

type Party = { user_id: string; role: string; name: string }

async function party(userId: string): Promise<Party | null> {
  const u = await model.findTargetUser(userId)
  if (!u) return null
  return { user_id: u.user_id, role: u.role, name: await push.getDisplayName(userId) }
}

function toView(call: ChatCall, caller: Party, callee: Party): ChatCallView {
  return {
    call_id:         call.call_id,
    conversation_id: call.conversation_id,
    caller_id:       caller.user_id,
    caller_name:     caller.name,
    caller_role:     caller.role,
    callee_id:       callee.user_id,
    callee_name:     callee.name,
    callee_role:     callee.role,
    status:          call.status,
    created_at:      call.created_at,
  }
}

async function viewOf(call: ChatCall): Promise<ChatCallView | null> {
  const [caller, callee] = await Promise.all([party(call.caller_id), party(call.callee_id)])
  return caller && callee ? toView(call, caller, callee) : null
}

function tell(userIds: string[], event: string, payload: unknown) {
  void Promise.allSettled(userIds.map((id) => broadcast(callTopic(id), event, payload)))
}

/**
 * Whether this user is on a call that is really still going. Open rows the two
 * ends never closed (a tab shut mid-call, a phone that lost power) are closed
 * here instead of leaving the person "busy" for ever.
 */
async function isBusy(userId: string): Promise<boolean> {
  const open = await CallModel.findOpenFor(userId)
  let busy = false
  for (const call of open) {
    if (call.status === 'ringing') {
      if (Date.now() - Date.parse(call.created_at) < STALE_RING_MS) { busy = true; continue }
      await CallModel.close(call.call_id, 'missed', 'timeout', null, ['ringing'])
      continue
    }
    // Answered: live only while somebody is still in the room. When LiveKit
    // can't be asked, trust the row.
    const inRoom = await roomParticipantCount(call.room_name)
    if (inRoom === null || inRoom > 0) { busy = true; continue }
    await CallModel.close(call.call_id, 'ended', 'timeout', null, ['answered'])
  }
  return busy
}

/* ── Caller ───────────────────────────────────────────────────────────────── */

export async function startCallService(
  me: { user_id: string; role: string },
  conversationId: string,
): Promise<{ call: ChatCallView; url: string; token: string; ring_seconds: number }> {
  if (!isLiveKitConfigured()) {
    logSystemThrottled('livekit.config', 60 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'livekit.config',
      message:    'Someone tried to call from Messages but LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set.',
    })
    throw new ChatCallError('Calling is not set up yet', 503)
  }
  if (me.role === 'client') throw new ChatCallError('Calls are not available on client accounts', 403)

  const conv = await model.findConversationById(conversationId)
  if (!conv || (conv.participant_a_id !== me.user_id && conv.participant_b_id !== me.user_id)) {
    throw new ChatCallError('Conversation not found', 404)
  }
  const otherId = conv.participant_a_id === me.user_id ? conv.participant_b_id : conv.participant_a_id

  const [caller, callee, target] = await Promise.all([party(me.user_id), party(otherId), model.findTargetUser(otherId)])
  if (!caller || !callee || !target) throw new ChatCallError('Conversation not found', 404)
  if (callee.role === 'client') throw new ChatCallError('Clients can only be messaged, not called', 403)
  if (target.status !== 'active') throw new ChatCallError(`${callee.name} can't take calls right now`, 409)

  if (await isBusy(me.user_id))  throw new ChatCallError(`You can't call ${callee.name} because you are currently on a call`, 409)
  if (await isBusy(otherId))     throw new ChatCallError(`${callee.name} is currently on a call with someone else`, 409)

  const call = await CallModel.create({
    conversation_id: conv.conversation_id,
    caller_id:       me.user_id,
    callee_id:       otherId,
    room_name:       `chat-${crypto.randomUUID()}`,
  })

  const token = await mintRoomToken({ room: call.room_name, identity: `user:${me.user_id}`, name: caller.name })
  const view  = toView(call, caller, callee)

  tell([otherId], 'chat_call_incoming', view)

  // A push too, for a closed tab or a phone with the app in the background:
  // opening it shows the ringer if the call is still ringing.
  void push.sendToUsers([otherId], {
    title: `Incoming call — ${caller.name}`,
    body:  'Open the app to answer.',
    data:  { type: 'chat.call', call_id: call.call_id, conversation_id: call.conversation_id },
    tag:   `chat-call-${call.call_id}`,
  })

  // Close it on the server if the caller vanishes without closing it itself.
  setTimeout(() => { void expireIfStillRinging(call.call_id) }, STALE_RING_MS).unref?.()

  return { call: view, url: liveKitUrl(), token, ring_seconds: RING_SECONDS }
}

async function expireIfStillRinging(callId: string) {
  try {
    const closed = await CallModel.close(callId, 'missed', 'timeout', null, ['ringing'])
    if (!closed) return
    tell([closed.caller_id, closed.callee_id], 'chat_call_closed', { call_id: callId, reason: 'timeout' })
    void notifyMissed(closed)
    void closeRoom(closed.room_name)
  } catch (e: any) {
    console.warn('[chat calls] could not expire call', callId, e?.message)
  }
}

/** A push to the callee for a call they never picked up. */
async function notifyMissed(call: ChatCall) {
  const name = await push.getDisplayName(call.caller_id)
  await push.sendToUsers([call.callee_id], {
    title: 'Missed call',
    body:  `${name} tried to call you.`,
    data:  { type: 'chat.call_missed', call_id: call.call_id, conversation_id: call.conversation_id },
    tag:   `chat-call-${call.call_id}`,
  })
}

/* ── Callee ───────────────────────────────────────────────────────────────── */

/** Calls ringing for me right now — for a page or app that just opened. */
export async function ringingForService(userId: string): Promise<ChatCallView[]> {
  const calls = await CallModel.findRingingFor(userId, new Date(Date.now() - STALE_RING_MS))
  return (await Promise.all(calls.map(viewOf))).filter((v): v is ChatCallView => !!v)
}

export async function answerCallService(
  userId: string,
  callId: string,
): Promise<{ call: ChatCallView; url: string; token: string }> {
  if (!isLiveKitConfigured()) throw new ChatCallError('Calling is not set up yet', 503)

  const existing = await CallModel.findById(callId)
  if (!existing || existing.callee_id !== userId) throw new ChatCallError('Call not found', 404)

  const call = await CallModel.claim(callId)
  if (!call) throw new ChatCallError('This call has ended', 409)

  // The caller hears it; the callee's other tabs and devices stop ringing.
  tell([call.caller_id, call.callee_id], 'chat_call_answered', { call_id: callId })

  const view = await viewOf(call)
  if (!view) throw new ChatCallError('Call not found', 404)
  const token = await mintRoomToken({ room: call.room_name, identity: `user:${userId}`, name: view.callee_name })

  return { call: view, url: liveKitUrl(), token }
}

export async function declineCallService(userId: string, callId: string): Promise<void> {
  const call = await CallModel.findById(callId)
  if (!call || call.callee_id !== userId) throw new ChatCallError('Call not found', 404)

  const closed = await CallModel.close(callId, 'declined', 'declined', userId, ['ringing'])
  if (!closed) return
  tell([closed.caller_id, closed.callee_id], 'chat_call_declined', { call_id: callId })
  void closeRoom(closed.room_name)
}

/* ── Either end ───────────────────────────────────────────────────────────── */

/**
 * Hang up. Before an answer this is the caller cancelling (or giving up after
 * the ring time, `no_answer`); after it, either end ending the call.
 */
export async function endCallService(
  userId: string,
  callId: string,
  reason: 'hangup' | 'no_answer' | 'failed',
  detail?: string,
): Promise<void> {
  const call = await CallModel.findById(callId)
  if (!call || (call.caller_id !== userId && call.callee_id !== userId)) throw new ChatCallError('Call not found', 404)

  const status = call.status === 'answered' ? 'ended' : 'missed'
  const closed = await CallModel.close(callId, status, reason, userId)
  if (!closed) return

  if (reason === 'failed') {
    console.warn('[chat calls] could not connect', callId, detail ?? '(no detail)')
    logSystemThrottled('livekit.connect', 10 * 60 * 1000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'livekit.connect',
      message:    `A call from Messages could not connect.${detail ? ` (${detail})` : ''}`,
      metadata:   { call_id: callId, detail: detail ?? null },
    })
  }

  tell([closed.caller_id, closed.callee_id], 'chat_call_closed', { call_id: callId, reason })
  if (status === 'missed') void notifyMissed(closed)
  void closeRoom(closed.room_name)
}
