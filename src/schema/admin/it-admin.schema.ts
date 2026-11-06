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
  /**
   * REQUIRED (user's rule 2026-11-06): the Company Administrator who takes over
   * on day 30 if nobody has confirmed, so the IT Admin can never stay past it.
   */
  standin_id: z.string({ error: 'Choose the Company Administrator who stands in after the 30 days' })
    .uuid('Choose the Company Administrator who stands in after the 30 days'),
})

/** Change the Company Administrator stand-in (it can be changed, never cleared). */
export const setStandinSchema = z.object({
  standin_id: z.string().uuid('Choose a Company Administrator'),
})
