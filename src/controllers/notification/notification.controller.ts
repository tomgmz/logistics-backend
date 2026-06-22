import { Request, Response } from 'express'
import { param } from '../../lib/controller-utils.js'
import * as service from '../../services/notification/notification.service.js'

function requireUserId(req: Request): string {
  const id = req.user?.sub
  if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  return id
}

export async function list(req: Request, res: Response) {
  try {
    const userId = requireUserId(req)
    const limitRaw = parseInt(String(req.query.limit ?? '30'), 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 30
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null

    const items = await service.listNotifications(userId, { limit, before })
    res.status(200).json({ status: 'success', data: items })
  } catch (error: any) {
    res.status(error.statusCode ?? 500).json({ status: 'error', message: error.message })
  }
}

export async function unreadCount(req: Request, res: Response) {
  try {
    const userId = requireUserId(req)
    const count = await service.getUnreadCount(userId)
    res.status(200).json({ status: 'success', data: { count } })
  } catch (error: any) {
    res.status(error.statusCode ?? 500).json({ status: 'error', message: error.message })
  }
}

export async function markRead(req: Request, res: Response) {
  try {
    const userId = requireUserId(req)
    const updated = await service.markRead(userId, param(req.params.id))
    res.status(200).json({ status: 'success', data: updated })
  } catch (error: any) {
    res.status(error.statusCode ?? 500).json({ status: 'error', message: error.message })
  }
}

export async function markAllRead(req: Request, res: Response) {
  try {
    const userId = requireUserId(req)
    const updated = await service.markAllRead(userId)
    res.status(200).json({ status: 'success', data: { updated } })
  } catch (error: any) {
    res.status(error.statusCode ?? 500).json({ status: 'error', message: error.message })
  }
}
