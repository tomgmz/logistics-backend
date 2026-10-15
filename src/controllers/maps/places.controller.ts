import { Request, Response } from 'express'
import {
  autocompletePlaces,
  placeDetails,
  PlacesUpstreamError,
} from '../../services/maps/places.service.js'
import { PlacesAutocompleteInput, PlaceDetailsInput } from '../../schema/maps/places.schema.js'

function sendError(res: Response, error: unknown) {
  if (error instanceof PlacesUpstreamError) {
    return res.status(error.upstreamStatus).json({ status: 'error', message: error.message })
  }
  console.error('[places] error:', error instanceof Error ? error.message : error)
  res.status(502).json({ status: 'error', message: 'Place search is unavailable right now.' })
}

export const autocomplete = async (req: Request<{}, {}, PlacesAutocompleteInput>, res: Response) => {
  try {
    res.status(200).json({ status: 'success', data: await autocompletePlaces(req.body) })
  } catch (error) {
    sendError(res, error)
  }
}

export const details = async (req: Request<{}, {}, PlaceDetailsInput>, res: Response) => {
  try {
    res.status(200).json({ status: 'success', data: await placeDetails(req.body) })
  } catch (error) {
    sendError(res, error)
  }
}
