import { Request, Response } from 'express'
import { param } from '../../lib/controller-utils.js'
import * as service from '../../services/notification/notification.service.js'
import { NOTIFICATION_FILTERS, type NotificationFilter } from '../../models/notification/notification.model.js'

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

    // Numbered pages for the web bell: ?page=N returns that page plus the total.
    // Without it the response is the plain list the driver app reads.
    const pageRaw = parseInt(String(req.query.page ?? ''), 10)
    if (Number.isFinite(pageRaw) && pageRaw >= 1) {
      // ?filter= narrows the pages (unread, or a type group); anything else is ignored.
      const filter = NOTIFICATION_FILTERS.includes(req.query.filter as NotificationFilter)
        ? (req.query.filter as NotificationFilter)
        : null
      const { items, total } = await service.pageNotifications(userId, { page: pageRaw, limit, filter })
      res.status(200).json({
        status: 'success',
        data:   items,
        meta:   { page: pageRaw, limit, filter, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      })
      return
    }

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
