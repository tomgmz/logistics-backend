import { z } from 'zod'
import { coreCreateFields, coreUpdateFields } from './shared.schema.js'

export const createVendorSchema = z.object({
  ...coreCreateFields(),
  vendor_type:     z.enum(['individual', 'company']),
  company_name:    z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
  business_permit: z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
}).refine(
  data => data.vendor_type !== 'company' || !!data.company_name,
  { path: ['company_name'], message: 'Company name is required for company vendors' }
)

export const updateVendorSchema = z.object({
  ...coreUpdateFields(),
  vendor_type:     z.enum(['individual', 'company']).optional(),
  company_name:    z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
  business_permit: z.string().max(100).optional().nullable().transform(v => v === '' ? null : v),
}).refine(
  data => {
    if (data.vendor_type === 'company') return !!data.company_name
    return true
  },
  { path: ['company_name'], message: 'Company name is required for company vendors' }
)