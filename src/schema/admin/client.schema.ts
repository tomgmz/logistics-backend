import { z } from 'zod'
import { coreCreateFields, coreUpdateFields, landlineField, passwordField } from './shared.schema.js'

export const createClientSchema = z.object({
  ...coreCreateFields(),
  landline: landlineField(),
  company_name: z
    .string({ error: 'Company name is required' })
    .min(1, 'Company name is required')
    .max(100, 'Company name is too long'),
  billing_address: z
    .string({ error: 'Billing address is required' })
    .min(1, 'Billing address is required'),
  // The reverse billing arrangement from the client's contract. The 30/45/60
  // payment term is NOT set here: it is chosen per booking and read off the
  // booking at invoice issuance.
  billing_mode: z.enum(['weekly', 'monthly'], { error: 'Reverse billing mode is required' }),
})

export const updateClientSchema = z.object({
  ...coreUpdateFields(),
  landline:        landlineField(),
  company_name:    z.string().max(100, 'Company name is too long').optional(),
  billing_address: z.string().optional(),
  billing_mode:    z.enum(['weekly', 'monthly']).optional(),
})

export const changePasswordSchema = z.object({
  password:         passwordField(),
})


