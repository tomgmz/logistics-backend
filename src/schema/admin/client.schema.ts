import { z } from 'zod'

export const createClientSchema = z.object({
  // from users table
  first_name: z.string().min(2).max(50),
  last_name: z.string().min(2).max(50),
  middle_initial: z.string().max(1).optional().nullable(),
  suffix: z.string().max(10).optional().nullable(),
  username: z.string().min(2).max(50),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().max(13).optional(),
  created_by: z.string().uuid().optional(),

  // from clients table
  company_name: z.string().max(100).optional(),
  billing_address: z.string().optional(),
  payment_terms: z.number().int().positive().default(30).optional(),
})

export const updateClientSchema = z.object({
  // from users table
  first_name: z.string().min(2).max(50).optional(),
  last_name: z.string().min(2).max(50).optional(),
  middle_initial: z.string().max(1).optional().nullable(),
  suffix: z.string().max(10).optional().nullable(),
  username: z.string().min(2).max(50).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(13).optional(),

  // from clients table
  company_name: z.string().max(100).optional(),
  billing_address: z.string().optional(),
  payment_terms: z.number().int().positive().optional(),
})