import { Request, Response, NextFunction } from 'express'
import * as service from '../../services/messaging/group.service.js'
import { z } from 'zod'

function getAuth(req: Request): { user_id: string; role: string } {
  const u = (req as Request & { user?: Record<string, unknown> }).user
  if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  const user_id = (u.user_id ?? u.id ?? u.sub) as string | undefined
  const role    = u.role as string | undefined
  if (!user_id) throw Object.assign(new Error('user_id missing'), { statusCode: 401 })
  return { user_id, role: role ?? '' }
}

function fail(res: Response, err: unknown): void {
  const e = err as { statusCode?: number; message?: string }
  if (e.statusCode) { res.status(e.statusCode).json({ success: false, message: e.message }); return }
  throw err
}

const createGroupSchema = z.object({
  name: z.string().min(1).max(100).transform(v => v.trim()),
  member_ids: z.array(z.string().uuid()).min(1).max(50),
})

const respondSchema = z.object({ accept: z.boolean() })

const sendGroupMessageSchema = z.object({
  content: z.string().min(1).max(5000).transform(v => v.trim()),
  reply_to_message_id: z.string().uuid().optional(),
})

const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
})

// message_ids has a default of [] so calling PATCH /groups/:id/read with {}
// still updates last_read_at (unread badge) without writing group_message_reads rows.
const markReadSchema = z.object({
  message_ids: z.array(z.string().uuid()).default([]),
})

const reactSchema = z.object({ emoji: z.string().min(1).max(10) })

export async function createGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = createGroupSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.status(201).json({ success: true, data: await service.createGroup(user_id, p.data.name, p.data.member_ids) })
  } catch (err) { fail(res, err) }
}

export async function getGroups(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    res.json({ success: true, data: await service.getGroups(user_id) })
  } catch (err) { next(err) }
}

export async function respondToInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = respondSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    await service.respondToInvite(req.params.groupId as string, user_id, p.data.accept)
    res.json({ success: true })
  } catch (err) { fail(res, err) }
}

export async function sendGroupMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = sendGroupMessageSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.status(201).json({ success: true, data: await service.sendGroupMessage(req.params.groupId as string, user_id, p.data.content, p.data.reply_to_message_id) })
  } catch (err) { fail(res, err) }
}

export async function getGroupMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = getMessagesQuerySchema.safeParse(req.query)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.json({ success: true, data: await service.getGroupMessages(req.params.groupId as string, user_id, p.data.limit, p.data.before) })
  } catch (err) { fail(res, err) }
}

export async function markGroupRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = markReadSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    await service.markGroupRead(req.params.groupId as string, user_id, p.data.message_ids)
    res.json({ success: true })
  } catch (err) { fail(res, err) }
}

export async function reactToGroupMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = reactSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.json({ success: true, data: await service.toggleGroupReaction(req.params.groupId as string, req.params.messageId as string, user_id, p.data.emoji) })
  } catch (err) { fail(res, err) }
}