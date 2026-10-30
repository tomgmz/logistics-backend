import { z } from 'zod'
import { coreCreateFields, coreUpdateFields, landlineField, passwordField } from './shared.schema.js'

const dateOnly = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)')
    .refine(val => !isNaN(new Date(`${val}T00:00:00Z`).getTime()), 'Invalid date')

// A new client's contract can't already have run out. An edit only checks the
// date is real, so a client whose contract has lapsed can still be saved.
const contractValidUntilField = () =>
  dateOnly().refine(
    val => val >= new Date().toISOString().slice(0, 10),
    'Contract validity date is already past',
  )

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
  contract_valid_until: contractValidUntilField(),
})

export const updateClientSchema = z.object({
  ...coreUpdateFields(),
  landline:        landlineField(),
  company_name:    z.string().max(100, 'Company name is too long').optional(),
  billing_address: z.string().optional(),
  contract_valid_until: dateOnly().optional(),
})

export const changePasswordSchema = z.object({
  password:         passwordField(),
})


