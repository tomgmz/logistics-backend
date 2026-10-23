import { z } from 'zod'

/** The driver starting the in-app call that follows their quick alert. */
export const startEmergencyCallSchema = z.object({
  report_id: z.string().uuid(),
})

/** How the driver's side of the call ended. */
export const endEmergencyCallSchema = z.object({
  reason: z.enum(['hangup', 'no_answer', 'failed', 'fell_back']),
  /** The phone's error when the call failed to connect. Diagnostic only. */
  detail: z.string().max(500).optional(),
})
