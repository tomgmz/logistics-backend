import { Request, Response } from 'express'

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY!

export const computeDirections = async (req: Request, res: Response) => {
  try {
    const upstream = await fetch(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-Goog-Api-Key':  GOOGLE_MAPS_KEY,
          'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.duration,routes.legs.duration',
        },
        body: JSON.stringify(req.body),
      }
    )

    const data = await upstream.json()

    if (!upstream.ok) {
      return res.status(upstream.status).json({ status: 'error', message: data })
    }

    res.status(200).json({ status: 'success', data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch directions'
    console.error('[directions] upstream error:', message)
    res.status(502).json({ status: 'error', message })
  }
}