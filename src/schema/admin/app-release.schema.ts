import { z } from 'zod'

export const appReleaseUploadUrlSchema = z.object({
  file_name:  z.string().trim().min(1).max(200),
  size_bytes: z.number().int().positive(),
})

export const publishAppReleaseSchema = z.object({
  key:     z.string().trim().min(1).max(300),
  // What drivers see on /download, e.g. "1.2.0".
  version: z.string().trim().min(1, 'Enter the version').max(30)
    .regex(/^[0-9A-Za-z.+-]+$/, 'Use a version like 1.2.0'),
  notes:   z.string().trim().max(1000).optional().nullable(),
})
