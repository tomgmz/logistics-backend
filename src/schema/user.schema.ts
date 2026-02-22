import { z } from 'zod'

export const createUserSchema = z.object({
  first_name: z.string().min(2).max(50),
  last_name: z.string().min(2).max(50),
  suffix: z.string().max(10).optional().nullable(),
  middle_initial: z.string().max(1).optional().nullable(),
  username: z.string().min(2).max(50),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().max(13).optional(),
  role: z.enum(['admin', 'super_admin', 'driver', 'porter', 'client', 'subcontractor']),
  created_by: z.string().uuid().optional(),

  //driver
  license_number: z.string().max(50).optional(),
  license_expiry: z.string().optional(),
  is_subcontractor_driver: z.boolean().optional(),
  subcontractor_id: z.string().uuid().optional(),

  //client
  company_name: z.string().max(100).optional(),
  billing_address: z.string().max(200).optional(),
  payment_terms: z.number().int().positive().optional(),

  //subcontractor
  company_name_subcon: z.string().max(100).optional(),
  business_permit: z.string().max(100).optional(),
  subcontractor_type: z.string().max(50).optional(),
}).superRefine((data, ctx) => {
  if (data.role === 'driver') {
    if (!data.license_number) {
      ctx.addIssue({
        path: ['license_number'],
        code: z.ZodIssueCode.custom,
        message: 'Driver must have a license number',
      })
    }
    if (!data.license_expiry) {
      ctx.addIssue({
        path: ['license_expiry'],
        code: z.ZodIssueCode.custom,
        message: 'Driver must have a license expiry date',
      })
    }
  }

  if (data.role === 'client') {
    if (!data.company_name) {
      ctx.addIssue({
        path: ['company_name'],
        code: z.ZodIssueCode.custom,
        message: 'Client must have a company name',
      })
    }
  }
})