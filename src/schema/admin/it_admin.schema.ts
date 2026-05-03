import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export const createITAdminSchema = z.object(coreCreateFields())
export const updateITAdminSchema  = z.object(coreUpdateFields())