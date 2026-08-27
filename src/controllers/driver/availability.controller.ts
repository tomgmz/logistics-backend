import { Request, Response } from 'express'
import { getRequestMeta } from '../../lib/controller-utils.js'
import * as AvailabilityService from '../../services/driver/availability.service.js'
import { phDay } from '../../lib/ph-date.js'

export async function getMyAvailability(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    if (!userId) return res.status(401).json({ status: 'error', message: 'Not authenticated' })

    const data = await AvailabilityService.getAvailability(userId)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message?.includes('No driver profile') ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function setMyAvailability(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    if (!userId) return res.status(401).json({ status: 'error', message: 'Not authenticated' })

    const data = await AvailabilityService.setAvailability(userId, req.body.status)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message?.includes('No driver profile') ? 404 : 400
    res.status(status).json({ status: 'error', message: err.message })
  }
}

/**
 * The driver's plan for one calendar month, defaulting to the month they are in
 * — the app opens on the current month and only asks for another when the driver
 * pages to it.
 */
export async function getMyAvailabilityDays(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    if (!userId) return res.status(401).json({ status: 'error', message: 'Not authenticated' })

    const month = String(req.query.month ?? '') || phDay().slice(0, 7)
    const data  = await AvailabilityService.getAvailabilityDays(userId, month)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message?.includes('No driver profile') ? 404
      : err.message?.includes('Invalid month') ? 400
      : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function setMyAvailabilityDays(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    if (!userId) return res.status(401).json({ status: 'error', message: 'Not authenticated' })

    const data = await AvailabilityService.setAvailabilityDays(userId, req.body.month, req.body.days)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message?.includes('No driver profile') ? 404 : 400
    res.status(status).json({ status: 'error', message: err.message })
  }
}
