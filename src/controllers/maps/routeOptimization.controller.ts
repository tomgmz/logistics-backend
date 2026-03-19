import { Request, Response } from 'express'
import { GoogleAuth } from 'google-auth-library'
import axios from 'axios'
import {
  geocodeAddressService,
  optimizeBookingRouteService,
  getOptimizedRouteService,
} from '../../services/maps/routeOptimization.service.js'

const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID!

async function getAccessToken(): Promise<string> {
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
      private_key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })

  const client = await auth.getClient()
  const tokenResponse = await client.getAccessToken()
  if (!tokenResponse.token) throw new Error('Failed to get Google access token')
  return tokenResponse.token
}

export const getOptimizedRoute = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params
    const result = await getOptimizedRouteService(bookingId as string)
    res.status(200).json({ status: 'success', data: result })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Something went wrong'
    const status = message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message })
  }
}

export const optimizeBookingRoute = async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    const accessToken = await getAccessToken()
    console.log('Access token obtained:', !!accessToken)

    const testResponse = await axios.post(
      `https://routeoptimization.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}:optimizeTours`,
      {
        model: {
          shipments: [
            {
              label: 'test_shipment',
              deliveries: [
                {
                  arrivalLocation: { latitude: 14.5995, longitude: 120.9842 },
                },
              ],
            },
          ],
          vehicles: [
            {
              label: 'test_truck',
              startLocation: { latitude: 14.6760, longitude: 121.0437 },
              endLocation: { latitude: 14.6760, longitude: 121.0437 },
            },
          ],
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    )

    console.log('Test response:', testResponse.data)

    const result = await optimizeBookingRouteService(id as string)
    res.status(200).json({ status: 'success', data: result })
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { data?: unknown } }
    console.error('Optimization error:', err.response?.data ?? err.message)
    console.error('Full error details:', JSON.stringify(err.response?.data, null, 2))
    const message = err.message ?? 'Something went wrong'
    const isNotFound = message.includes('not found')
    const isBadRequest =
      message.includes('no destinations') ||
      message.includes('Cannot optimize')
    const httpStatus = isNotFound ? 404 : isBadRequest ? 400 : 500
    res.status(httpStatus).json({
      status: 'error',
      message,
      details: err.response?.data,
    })
  }
}

export const geocodeAddress = async (req: Request, res: Response) => {
  try {
    const { address } = req.body
    const result = await geocodeAddressService(address as string)
    res.status(200).json({ status: 'success', data: result })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Something went wrong'
    res.status(500).json({ status: 'error', message })
  }
}