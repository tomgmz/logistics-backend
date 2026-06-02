import { z } from 'zod'

const latLngSchema = z.object({
  latitude:  z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
})

const waypointSchema = z.object({
  location: z.object({
    latLng: latLngSchema,
    heading: z.number().min(0).max(360).optional(),
  }),
  sideOfRoad: z.boolean().optional(),
})

export const computeDirectionsSchema = z.object({
  origin:      waypointSchema,
  destination: waypointSchema,
  extraComputations: z
  .array(z.string())
  .optional(),
  fast: z.boolean().optional().default(false),

  intermediates: z.array(waypointSchema).optional(),

  travelMode: z
    .enum(['DRIVE'])
    .optional()
    .default('DRIVE'),

  routingPreference: z
    .enum([
      'ROUTING_PREFERENCE_UNSPECIFIED',
      'TRAFFIC_UNAWARE',
      'TRAFFIC_AWARE',
      'TRAFFIC_AWARE_OPTIMAL',
    ])
    .optional(),

  routeModifiers: z
    .object({
      avoidTolls:    z.boolean().optional(),
      avoidHighways: z.boolean().optional(),
      avoidFerries:  z.boolean().optional(),
    })
    .optional(),

  departureTime: z
    .string()
    .datetime({ message: 'departureTime must be ISO 8601' })
    .optional(),

  computeAlternativeRoutes: z.boolean().optional().default(false),

  languageCode: z.string().optional(),

  units: z.enum(['METRIC', 'IMPERIAL']).optional().default('METRIC'),
})

export type ComputeDirectionsInput = z.infer<typeof computeDirectionsSchema>