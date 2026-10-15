import { z } from 'zod'

const sessionToken = z.string().min(8).max(100)

export const placesAutocompleteSchema = z.object({
  input:        z.string().trim().min(3).max(200),
  sessionToken: sessionToken.optional(),
  // Where the map is looking, so nearby places rank first.
  near: z
    .object({
      latitude:  z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
})

export const placeDetailsSchema = z.object({
  placeId:      z.string().min(1).max(300),
  sessionToken: sessionToken.optional(),
})

export type PlacesAutocompleteInput = z.infer<typeof placesAutocompleteSchema>
export type PlaceDetailsInput       = z.infer<typeof placeDetailsSchema>
