import { z } from 'zod'

export const createLandlinePrefixSchema = z.object({
  prefix:    z.string().min(1).max(4).regex(/^\d+$/, 'Prefix must be numeric digits only'),
  city:      z.string().min(1).max(100).trim(),
})

export const updateLandlinePrefixSchema = z.object({
  prefix:    z.string().min(1).max(4).regex(/^\d+$/, 'Prefix must be numeric digits only').optional(),
  city:      z.string().min(1).max(100).trim().optional(),
})