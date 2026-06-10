import { Request, Response, NextFunction } from 'express'
import * as service from '../../services/messaging/push.service.js'
import { subscribeSchema, unsubscribeSchema } from '../../schema/messaging/push.schema.js'

function getUserId(req: Request): string {
  const u = (req as Request & { user?: Record<string, unknown> }).user
  const user_id = (u?.user_id ?? u?.id ?? u?.sub) as string | undefined
  if (!user_id || user_id === 'undefined') throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  return user_id
}

export async function subscribe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user_id = getUserId(req)
    const p = subscribeSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    await service.registerSubscription(user_id, {
      platform:    p.data.platform,
      token:       p.data.token,
      keys:        p.data.keys ?? null,
      device_info: p.data.device_info ?? null,
    })
    res.status(201).json({ success: true })
  } catch (err) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) { res.status(e.statusCode).json({ success: false, message: e.message }); return }
    next(err)
  }
}

export async function unsubscribe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    getUserId(req)
    const p = unsubscribeSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    await service.unregister(p.data.token)
    res.json({ success: true })
  } catch (err) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode) { res.status(e.statusCode).json({ success: false, message: e.message }); return }
    next(err)
  }
}
