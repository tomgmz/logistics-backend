import { Request, Response, NextFunction } from 'express'
import * as service from '../../services/messaging/group.service.js'
import { z } from 'zod'
import { reactSchema, messageBody } from '../../schema/messaging/messaging.schema.js'

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

const renameGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

const decideRequestSchema = z.object({ approve: z.boolean() })

const addMembersSchema = z.object({
  member_ids: z.array(z.string().uuid()).min(1).max(50),
})

const sendGroupMessageSchema = z.object(messageBody)
  .refine(v => v.content.length > 0 || !!v.attachment_url, { message: 'Type a message or add a photo', path: ['content'] })

const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
})

const markReadSchema = z.object({})

export async function createGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id, role } = getAuth(req)
    const p = createGroupSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.status(201).json({ success: true, data: await service.createGroup(user_id, role, p.data.name, p.data.member_ids) })
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
    res.status(201).json({ success: true, data: await service.sendGroupMessage(req.params.groupId as string, user_id, p.data.content, p.data.reply_to_message_id, p.data.attachment_url) })
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
    await service.markGroupRead(req.params.groupId as string, user_id)
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

export async function renameGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = renameGroupSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.json({ success: true, data: await service.renameGroup(req.params.groupId as string, user_id, p.data.name) })
  } catch (err) { fail(res, err) }
}

export async function addMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = addMembersSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    res.json({ success: true, data: await service.addMembers(req.params.groupId as string, user_id, p.data.member_ids) })
  } catch (err) { fail(res, err) }
}

export async function removeMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    res.json({ success: true, data: await service.removeMember(req.params.groupId as string, user_id, req.params.userId as string) })
  } catch (err) { fail(res, err) }
}

export async function listMemberRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    res.json({ success: true, data: await service.listMemberRequests(req.params.groupId as string, user_id) })
  } catch (err) { fail(res, err) }
}

export async function decideMemberRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    const p = decideRequestSchema.safeParse(req.body)
    if (!p.success) { res.status(400).json({ success: false, errors: p.error.flatten().fieldErrors }); return }
    await service.decideMemberRequest(req.params.groupId as string, req.params.requestId as string, user_id, p.data.approve)
    res.json({ success: true })
  } catch (err) { fail(res, err) }
}

export async function hideGroupMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_id } = getAuth(req)
    // ?scope=everyone unsends (sender only); otherwise it is hidden for the caller.
    if (req.query.scope === 'everyone')
      await service.unsendGroupMessage(req.params.groupId as string, req.params.messageId as string, user_id)
    else
      await service.hideGroupMessage(req.params.groupId as string, req.params.messageId as string, user_id)
    res.json({ success: true })
  } catch (err) { fail(res, err) }
}
