import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import { supabase } from '../../lib/supabase.js'
import * as push from '../../services/messaging/push.service.js'
import {
  CallError,
  startCallService,
  endCallAsDriverService,
  ringingForService,
  answerCallService,
  endCallAsStaffService,
} from '../../services/driver/emergency-call.service.js'

/**
 * The in-app emergency call. Drivers place and close it; Operations Managers and
 * Company Administrators answer and close it. Every driver read is scoped to
 * the driver on the SESSION, never to an id in the URL alone.
 */

async function myDriverId(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return (data as any)?.driver_id ?? null
}

function fail(res: Response, error: any) {
  const status = error instanceof CallError ? error.status : 500
  res.status(status).json({ status: 'error', message: error?.message ?? 'Something went wrong' })
}

export const startCall = async (req: Request, res: Response) => {
  try {
    const { userId } = getRequestMeta(req)
    const driverId = await myDriverId(userId)
    if (!driverId || !userId) {
      return res.status(403).json({ status: 'error', message: 'Only a driver can place this call' })
    }
    const data = await startCallService(driverId, userId, req.body.report_id)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    fail(res, error)
  }
}

export const endCallAsDriver = async (req: Request, res: Response) => {
  try {
    const { userId } = getRequestMeta(req)
    const driverId = await myDriverId(userId)
    if (!driverId || !userId) return res.status(404).json({ status: 'error', message: 'Call not found' })
    await endCallAsDriverService(driverId, userId, param(req.params.callId), req.body.reason, req.body.detail)
    res.status(200).json({ status: 'success' })
  } catch (error: any) {
    fail(res, error)
  }
}

export const listRinging = async (req: Request, res: Response) => {
  try {
    const { userId } = getRequestMeta(req)
    if (!userId) return res.status(200).json({ status: 'success', data: [] })
    res.status(200).json({ status: 'success', data: await ringingForService(userId) })
  } catch (error: any) {
    fail(res, error)
  }
}

export const answerCall = async (req: Request, res: Response) => {
  try {
    const { userId } = getRequestMeta(req)
    if (!userId) return res.status(404).json({ status: 'error', message: 'Call not found' })
    const name = await push.getDisplayName(userId)
    const data = await answerCallService(param(req.params.callId), { userId, name })
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    fail(res, error)
  }
}

export const endCallAsStaff = async (req: Request, res: Response) => {
  try {
    const { userId } = getRequestMeta(req)
    if (!userId) return res.status(404).json({ status: 'error', message: 'Call not found' })
    await endCallAsStaffService(param(req.params.callId), userId)
    res.status(200).json({ status: 'success' })
  } catch (error: any) {
    fail(res, error)
  }
}
