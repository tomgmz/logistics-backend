import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export { emailField, mobileField } from './shared.schema.js'

export const createFleetAdminSchema      = z.object(coreCreateFields())
export const updateFleetAdminSchema      = z.object(coreUpdateFields())

export const createOperationsAdminSchema = z.object(coreCreateFields())
export const updateOperationsAdminSchema = z.object(coreUpdateFields())