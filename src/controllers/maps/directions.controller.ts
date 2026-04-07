import { Request, Response } from 'express'
import {
  computeDirectionsService,
  DirectionsUpstreamError,
} from '../../services/maps/directions.service.js'

export const computeDirections = async (req: Request, res: Response) => {
  try {
    const result = await computeDirectionsService(req.body)
    res.status(200).json({ status: 'success', data: result })
  } catch (error: unknown) {
    if (error instanceof DirectionsUpstreamError) {
      return res
        .status(error.upstreamStatus)
        .json({ status: 'error', message: error.message })
    }

    const message =
      error instanceof Error ? error.message : 'Failed to fetch directions'

    console.error('[directions] error:', message)
    res.status(502).json({ status: 'error', message })
  }
}