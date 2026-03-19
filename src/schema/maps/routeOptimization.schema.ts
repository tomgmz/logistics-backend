import { z } from 'zod'

export const optimizeRouteSchema = z.object({
  booking_id: z.string().uuid('Invalid booking ID'),
})

export const geocodeAddressSchema = z.object({
  address: z.string().min(1, 'Address is required'),
})

export const manualCoordinatesSchema = z.object({
  destinations: z.array(
    z.object({
      destination_id: z.string().uuid(),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
  ).min(1, 'At least one destination is required'),
  origin_latitude: z.number().min(-90).max(90).optional(),
  origin_longitude: z.number().min(-180).max(180).optional(),
})