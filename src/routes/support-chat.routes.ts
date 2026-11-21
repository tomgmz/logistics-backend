import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { attachClientScope } from '../middlewares/clientScope.middleware.js'
import { validate } from '../middlewares/validate.middleware.js'
import { requireModule } from '../middlewares/moduleAccess.middleware.js'
import { pageQuery, paginate, searchQuery, matchesWords } from '../lib/paginate.js'
import * as Chat from '../services/support/conversation.service.js'
import { messageBodyColumns } from '../services/messaging/photo.service.js'
import { PHOTO_PLACEHOLDER } from '../schema/messaging/messaging.schema.js'

/**
 * Client support conversations: the help assistant, our team and email in one
 * thread (2026-11-22). Mounted under /support next to tickets.
 *
 *   client  GET   /conversations              their list
 *           POST  /conversations              start one (first question)
 *           GET   /conversations/:id          one, with messages
 *           POST  /conversations/:id/lines    the assistant part (question + answer shown)
 *           POST  /conversations/:id/handover "Talk to our team"
 *           POST  /conversations/:id/messages write to the team
 *           PATCH /conversations/:id/read
 *   staff   GET   /inbox?status=waiting|replied|resolved|all  (paged)
 *           GET   /inbox/:id
 *           POST  /inbox/:id/messages         reply
 *           PATCH /inbox/:id/read
 *           POST  /inbox/:id/resolve
 *
 * Staff = Company Administrator + Operations Manager, gated by the Tickets
 * module (its Read Only tier blocks replies, resolving and tickets).
 */

const router = Router()

const isClient      = authorize('client')
const isSupportDesk = authorize('admin', 'operations_manager')
const uuidParam     = z.string().uuid()

const chatBodySchema = z.object({
  content:        z.string().max(4000).optional().default('').transform((v) => v.trim()),
  attachment_url: z.string().max(1000).optional(),
}).refine((v) => v.content.length > 0 || !!v.attachment_url, { message: 'Type a message or add a photo', path: ['content'] })

const staffReplySchema = z.object({
  content:              z.string().max(4000).optional().default('').transform((v) => v.trim()),
  attachment_url:       z.string().max(1000).optional(),
  /** The newest message the sender had on screen, for the "replied while you were writing" check. */
  last_seen_message_id: z.string().uuid().nullable().optional(),
  force:                z.boolean().optional(),
}).refine((v) => v.content.length > 0 || !!v.attachment_url, { message: 'Type a message or add a photo', path: ['content'] })

const startSchema = z.object({ title: z.string().trim().max(150).optional().default('') }).strict()

const linesSchema = z.object({
  lines: z.array(z.object({
    author: z.enum(['client', 'assistant']),
    text:   z.string().trim().min(1).max(4000),
    meta:   z.object({
      ai:     z.boolean().optional(),
      faq_id: z.string().max(80).optional(),
    }).strict().nullable().optional(),
  })).min(1).max(10),
}).strict()

function fail(res: Response, err: any) {
  const status = err?.statusCode ?? (String(err?.message ?? '').includes('not found') ? 404 : 500)
  if (status === 500) console.error('[support-chat]', err)
  res.status(status).json({ status: 'error', message: status === 500 ? 'Something went wrong' : err.message, ...(err?.code && status !== 500 ? { code: err.code } : {}) })
}

function idOf(req: Request, res: Response): string | null {
  const id = String(req.params.id)
  if (!uuidParam.safeParse(id).success) { res.status(400).json({ status: 'error', message: 'Invalid conversation' }); return null }
  return id
}

function bodyOf(req: Request) {
  const b = messageBodyColumns(req.body.content, req.body.attachment_url, PHOTO_PLACEHOLDER)
  return { content: b.content, attachment_url: b.attachment_url, attachment_stamped: b.attachment_stamped }
}

router.use(authenticate, authenticatedLimiter)

// ── Client ───────────────────────────────────────────────────────────────────

router.get('/conversations', isClient, async (req: Request, res: Response) => {
  try { res.status(200).json({ status: 'success', data: await Chat.listForClient(req.user!.sub) }) }
  catch (err) { fail(res, err) }
})

router.post('/conversations', isClient, attachClientScope, validate(startSchema), async (req: Request, res: Response) => {
  try { res.status(201).json({ status: 'success', data: await Chat.create(req.clientId!, req.user!.sub, req.body.title) }) }
  catch (err) { fail(res, err) }
})

router.get('/conversations/:id', isClient, async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { res.status(200).json({ status: 'success', data: await Chat.getForClient(id, req.user!.sub) }) }
  catch (err) { fail(res, err) }
})

router.post('/conversations/:id/lines', isClient, validate(linesSchema), async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { res.status(201).json({ status: 'success', data: await Chat.appendAssistantLines(id, req.user!.sub, req.body.lines) }) }
  catch (err) { fail(res, err) }
})

router.post('/conversations/:id/handover', isClient, async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { res.status(200).json({ status: 'success', data: await Chat.handOver(id, req.user!.sub) }) }
  catch (err) { fail(res, err) }
})

router.post('/conversations/:id/messages', isClient, validate(chatBodySchema), async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { res.status(201).json({ status: 'success', data: await Chat.clientMessage(id, req.user!.sub, bodyOf(req)) }) }
  catch (err) { fail(res, err) }
})

router.patch('/conversations/:id/read', isClient, async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { await Chat.markRead(id, req.user!.sub, true); res.status(200).json({ status: 'success' }) }
  catch (err) { fail(res, err) }
})

// ── Staff inbox ──────────────────────────────────────────────────────────────

router.get('/inbox', isSupportDesk, requireModule('support-tickets'), async (req: Request, res: Response) => {
  try {
    const raw    = String(req.query.status ?? 'waiting')
    const status = ['waiting', 'replied', 'resolved', 'all', 'mine'].includes(raw) ? raw : 'waiting'
    const me     = req.user!.sub
    const all    = await Chat.listForStaff(me)
    // Mine = open conversations I own (waiting or replied).
    const isMine = (c: any) => c.assigned_to === me && (c.status === 'waiting' || c.status === 'replied')
    // Waiting / Replied / Resolved hold what reached the team; "All" also has
    // the conversations the assistant handled alone.
    const counts = {
      waiting:  all.filter((c: any) => c.status === 'waiting').length,
      replied:  all.filter((c: any) => c.status === 'replied').length,
      // Resolved = closed after reaching the team (assistant-only ones show under All).
      resolved: all.filter((c: any) => c.status === 'resolved' && c.handed_over_at).length,
      all:      all.length,
      mine:     all.filter(isMine).length,
    }
    const q = searchQuery(req)
    const oldestFirst = req.query.sort === 'asc'
    const rows = all
      .filter((c: any) => (status === 'all' || (status === 'mine' ? isMine(c)
        : status === 'resolved' ? c.status === 'resolved' && !!c.handed_over_at : c.status === status)) &&
        matchesWords(q, [c.reference, c.company_name, c.client_name, c.title, c.last_message?.content]))
      .sort((a: any, b: any) => (oldestFirst
        ? String(a.last_message_at).localeCompare(String(b.last_message_at))
        : String(b.last_message_at).localeCompare(String(a.last_message_at))))
    const paging = pageQuery(req)
    if (!paging) return res.status(200).json({ status: 'success', data: rows, meta: { counts } })
    const { data, meta } = paginate(rows, paging)
    res.status(200).json({ status: 'success', data, meta: { ...meta, counts } })
  } catch (err) { fail(res, err) }
})

router.get('/inbox/:id', isSupportDesk, requireModule('support-tickets'), async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { res.status(200).json({ status: 'success', data: await Chat.getForStaff(id) }) }
  catch (err) { fail(res, err) }
})

router.post('/inbox/:id/messages', isSupportDesk, requireModule('support-tickets'), validate(staffReplySchema), async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try {
    const data = await Chat.staffReply(id, req.user!.sub, bodyOf(req), { lastSeenMessageId: req.body.last_seen_message_id ?? null, force: !!req.body.force })
    res.status(201).json({ status: 'success', data })
  } catch (err) { fail(res, err) }
})

router.post('/inbox/:id/take-over', isSupportDesk, requireModule('support-tickets'), async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { res.status(200).json({ status: 'success', data: await Chat.takeOver(id, req.user!.sub) }) }
  catch (err) { fail(res, err) }
})

// Marking read is reading, so a Read Only member can do it (PATCH would need write access).
router.patch('/inbox/:id/read', isSupportDesk, async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { await Chat.markRead(id, req.user!.sub, false); res.status(200).json({ status: 'success' }) }
  catch (err) { fail(res, err) }
})

router.post('/inbox/:id/resolve', isSupportDesk, requireModule('support-tickets'), async (req: Request, res: Response) => {
  const id = idOf(req, res); if (!id) return
  try { res.status(200).json({ status: 'success', data: await Chat.resolve(id, req.user!.sub) }) }
  catch (err) { fail(res, err) }
})

export default router
