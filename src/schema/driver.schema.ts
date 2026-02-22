import { z } from 'zod'

export const createDriverSchema = z.object({
  first_name:     z.string().min(2).max(50),
  last_name:      z.string().min(2).max(50),
  middle_initial: z.string().max(1).optional().nullable(),
  suffix:         z.string().max(10).optional().nullable(),
  username:       z.string().min(2).max(50),
  email:          z.string().email(),
  password:       z.string().min(8),
  phone:          z.string().max(13).optional().nullable(),
  created_by:     z.string().uuid().optional().nullable(),

  license_number:           z.string().min(1).max(50),
  license_expiry:           z.string().min(1),
  is_subcontractor_driver:  z.boolean().optional().default(false),
  subcontractor_id:         z.string().uuid().optional().nullable(),
}).refine(
  (data) => !data.is_subcontractor_driver || !!data.subcontractor_id,
  {
    path: ['subcontractor_id'],
    message: 'Subcontractor ID is required when driver is a subcontractor driver',
  }
)

export const updateDriverSchema = z.object({
  first_name:               z.string().min(2).max(50).optional(),
  last_name:                z.string().min(2).max(50).optional(),
  middle_initial:           z.string().max(1).optional().nullable(),
  suffix:                   z.string().max(10).optional().nullable(),
  phone:                    z.string().max(13).optional().nullable(),
  license_number:           z.string().min(1).max(50).optional(),
  license_expiry:           z.string().optional(),
  is_subcontractor_driver:  z.boolean().optional(),
  subcontractor_id:         z.string().uuid().optional().nullable(),
}).refine(
  (data) => !data.is_subcontractor_driver || !!data.subcontractor_id,
  {
    path: ['subcontractor_id'],
    message: 'Subcontractor ID is required when driver is a subcontractor driver',
  }
)