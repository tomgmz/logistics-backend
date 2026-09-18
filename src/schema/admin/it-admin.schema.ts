import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export const createITAdminSchema = z.object({
  ...coreCreateFields(),
})

export const updateITAdminSchema = z.object({
  ...coreUpdateFields(),
})

/**
 * A handover: the successor's details, and why.
 *
 * `created_by` is dropped from the core fields on purpose — on this route the
 * actor is the root admin resolved from the session, and accepting a client-
 * supplied value would let the audit trail be written by the caller.
 */
export const transitionITAdminSchema = z.object({
  ...(() => {
    const { created_by: _ignored, ...rest } = coreCreateFields()
    return rest
  })(),
  reason: z
    .string()
    .trim()
    .min(10, 'Give a reason of at least 10 characters — this goes on the audit record')
    .max(500, 'Reason is too long'),
})