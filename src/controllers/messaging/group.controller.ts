import { Request, Response, NextFunction } from 'express'
import * as groupService from '../../services/messaging/group.service.js'
import { z } from 'zod'

function getAuthUser(req: Request) {
  const user = (req as any).user as Record<string, unknown> | undefined
  if (!user) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  const user_id = (user.user_id ?? user.id ?? user.sub) as string
  const role = user.role as string
  if (!user_id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  return { user_id, role }
}

const createGroupSchema = z.object({
  name: z.string().min(1).max(100).transform(v => v.trim()),
  member_ids: z.array(z.string().uuid()).min(1).max(50),
})

const respondSchema = z.object({
  accept: z.boolean(),
})

const sendGroupMessageSchema = z.object({
  content: z.string().min(1).max(5000).transform(v => v.trim()),
})

const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
})

const markReadSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1),
})

export async function createGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const parsed = createGroupSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }
    const result = await groupService.createGroup(user_id, parsed.data.name, parsed.data.member_ids)
    res.status(201).json({ success: true, data: result })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function getGroups(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const groups = await groupService.getGroups(user_id)
    res.json({ success: true, data: groups })
  } catch (err) {
    next(err)
  }
}

export async function respondToInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const groupId = req.params.groupId as string
    const parsed = respondSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }
    await groupService.respondToInvite(groupId, user_id, parsed.data.accept)
    res.json({ success: true })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function sendGroupMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const groupId = req.params.groupId as string
    const parsed = sendGroupMessageSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }
    const message = await groupService.sendGroupMessage(groupId, user_id, parsed.data.content)
    res.status(201).json({ success: true, data: message })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function getGroupMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const groupId = req.params.groupId as string
    const parsed = getMessagesQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }
    const messages = await groupService.getGroupMessages(groupId, user_id, parsed.data.limit, parsed.data.before)
    res.json({ success: true, data: messages })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}

export async function markGroupRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuthUser(req)
    const groupId = req.params.groupId as string
    const parsed = markReadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors })
      return
    }
    await groupService.markGroupRead(groupId, user_id, parsed.data.message_ids)
    res.json({ success: true })
  } catch (err: any) {
    if (err.statusCode) { res.status(err.statusCode).json({ success: false, message: err.message }); return }
    next(err)
  }
}