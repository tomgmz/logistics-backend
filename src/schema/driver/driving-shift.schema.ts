import { z } from 'zod'

/** "I'm taking the wheel": the phone's time of the tap, and where the truck was. */
export const takeWheelSchema = z.object({
  at:        z.string().datetime().optional().nullable(),
  latitude:  z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
}).strict()

/** The office swaps the main and second driver on the road. */
export const swapDriversSchema = z.object({
  reason: z.string().trim().min(3, 'Say why the drivers are being swapped').max(500),
}).strict()
