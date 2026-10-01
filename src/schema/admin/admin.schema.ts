import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

// Same field rules as every other role (shared.schema). This file used to carry
// its own copy, which had drifted: a looser email check and a phone that took
// landlines and could be left out, unlike the form that feeds it.
export const createAdminSchema = z.object(coreCreateFields())
export const updateAdminSchema = z.object(coreUpdateFields())
