import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export const createAccountantSchema = z.object(coreCreateFields())
export const updateAccountantSchema  = z.object(coreUpdateFields())