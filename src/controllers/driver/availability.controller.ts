import { Request, Response } from 'express'
import { getRequestMeta } from '../../lib/controller-utils.js'
import * as AvailabilityService from '../../services/driver/availability.service.js'

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
