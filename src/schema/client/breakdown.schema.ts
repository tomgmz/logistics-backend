import { z } from 'zod'

/** "Truck is moving again": what happened to the breakdown the driver reported. */
export const dismissBreakdownSchema = z.object({
  note: z.string().trim().min(3, 'Say what happened to the breakdown').max(500),
}).strict()
