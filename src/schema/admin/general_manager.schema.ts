import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export const createGeneralManagerSchema = z.object(coreCreateFields())
export const updateGeneralManagerSchema  = z.object(coreUpdateFields())