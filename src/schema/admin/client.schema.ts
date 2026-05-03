import { z } from 'zod'
import { coreCreateFields, coreUpdateFields, landlineField } from './shared.schema.js'

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
  payment_terms: z.number().int().positive().default(30).optional(),
})

export const updateClientSchema = z.object({
  ...coreUpdateFields(),
  landline:        landlineField(),
  company_name:    z.string().max(100, 'Company name is too long').optional(),
  billing_address: z.string().optional(),
  payment_terms:   z.number().int().positive().optional(),
})