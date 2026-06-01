import { Request, Response } from 'express'
import {
  computeDirectionsService,
  DirectionsUpstreamError,
} from '../../services/maps/directions.service.js'
import { ComputeDirectionsInput } from '../../schema/maps/directions.schema.js'

export const computeDirections = async (
  req: Request<{}, {}, ComputeDirectionsInput>,
  res: Response
) => {
  try {
    const result = await computeDirectionsService(req.body)

    if (process.env.NODE_ENV !== 'production') {
      const route = result.routes?.[0] as any
      if (route) {
        const intervals = route.travelAdvisory?.speedReadingIntervals ?? []
        console.log(
          `[MAPS DEBUG] duration=${route.duration} static=${route.staticDuration} intervals=${intervals.length}`,
        )
      }
    }

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