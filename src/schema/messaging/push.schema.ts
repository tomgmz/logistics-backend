import { z } from 'zod'

export const subscribeSchema = z.object({
  platform:    z.enum(['web', 'expo']),
  token:       z.string().min(1).max(2048),
  keys:        z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).nullish(),
  device_info: z.string().max(255).nullish(),
}).refine((v) => v.platform !== 'web' || (v.keys?.p256dh && v.keys?.auth), {
  message: 'web subscriptions require keys.p256dh and keys.auth',
  path: ['keys'],
})

export const unsubscribeSchema = z.object({
  token: z.string().min(1).max(2048),
})
