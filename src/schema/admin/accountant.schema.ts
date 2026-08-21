import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export const createAccountantSchema = z.object(coreCreateFields())
export const updateAccountantSchema  = z.object(coreUpdateFields())
// IT-admin appointment of an accountant as the GM's booking-approval proxy.
export const setGmProxySchema = z.object({
  is_gm_proxy: z.boolean(),
})
