import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export const updateITAdminSchema = z.object({
  ...coreUpdateFields(),
})

/**
 * The successor's details. `created_by` is dropped from the core fields on
 * purpose: the actor is the outgoing IT Admin from the session, never the body.
 */
export const itAdminSuccessorSchema = z.object(
  (() => {
    const { created_by: _ignored, ...rest } = coreCreateFields()
    return rest
  })(),
)

/** Starting a handover: why (kept on the audit record), and the successor if already known. */
export const startHandoverSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'Give a reason of at least 10 characters — this goes on the audit record')
    .max(500, 'Reason is too long'),
  successor: itAdminSuccessorSchema.nullable().optional(),
  // No stand-in to choose since 2026-11-27: the General Manager takes over on
  // day 30 (it-admin.service findActiveGm). An old client still sending one is ignored.
})

/** The General Manager asks to take over an IT Administrator who can't be reached (2026-11-27). */
export const startTakeoverSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'Give a reason of at least 10 characters — this goes on the audit record')
    .max(500, 'Reason is too long'),
})
