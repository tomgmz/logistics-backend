import { Request, Response, NextFunction } from 'express'
import {
  ChatCallError,
  startCallService,
  ringingForService,
  answerCallService,
  declineCallService,
  endCallService,
} from '../../services/messaging/chat-call.service.js'
import { startChatCallSchema, endChatCallSchema } from '../../schema/messaging/messaging.schema.js'

/**
 * Voice calls from a direct conversation. Every call is scoped to the user on
 * the SESSION: only its two ends can see, answer or close it.
 */

function getAuth(req: Request): { user_id: string; role: string } {
  const u = (req as Request & { user?: Record<string, unknown> }).user
  if (!u) throw new ChatCallError('Unauthorized', 401)
  const user_id = (u.user_id ?? u.id ?? u.sub) as string | undefined
  const role    = u.role as string | undefined
  if (!user_id || user_id === 'undefined' || !role) throw new ChatCallError('Unauthorized', 401)
  return { user_id, role }
}

function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof ChatCallError) { res.status(err.status).json({ success: false, message: err.message }); return }
  next(err)
}

const callId = (req: Request) => String(req.params.callId ?? '')
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

export async function startCall(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const me = getAuth(req)
    const p = startChatCallSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.status(201).json({ success: true, data: await startCallService(me, p.data.conversation_id) })
  } catch (err) { fail(res, next, err) }
}

export async function listRinging(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    res.json({ success: true, data: await ringingForService(user_id) })
  } catch (err) { fail(res, next, err) }
}

export async function answerCall(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    if (!isUuid(callId(req))) { res.status(404).json({ success: false, message: 'Call not found' }); return }
    res.json({ success: true, data: await answerCallService(user_id, callId(req)) })
  } catch (err) { fail(res, next, err) }
}

export async function declineCall(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    if (!isUuid(callId(req))) { res.status(404).json({ success: false, message: 'Call not found' }); return }
    await declineCallService(user_id, callId(req))
    res.json({ success: true })
  } catch (err) { fail(res, next, err) }
}

export async function endCall(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    if (!isUuid(callId(req))) { res.status(404).json({ success: false, message: 'Call not found' }); return }
    const p = endChatCallSchema.safeParse(req.body ?? {})
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    await endCallService(user_id, callId(req), p.data.reason, p.data.detail)
    res.json({ success: true })
  } catch (err) { fail(res, next, err) }
}
