import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { attachClientScope } from '../middlewares/clientScope.middleware.js'
import { validate } from '../middlewares/validate.middleware.js'
import * as Support from '../services/support/support.service.js'

/**
 * Client support tickets, raised from the web FAQ chatbot.
 *
 *   POST  /support/tickets               client opens one (emails the inbox)
 *   GET   /support/tickets/mine          the client's own tickets
 *   GET   /support/tickets?status=open   staff queue (dashboard)
 *   PATCH /support/tickets/:id/resolve   staff mark it resolved (emails the client)
 *
 * Staff = the Company Administrator and the Operations Manager, the desk that
 * talks to clients. The conversation itself happens by email.
 */

const router = Router()

const isClient       = authorize('client')
const isSupportDesk  = authorize('admin', 'operations_manager')

const openTicketSchema = z.object({
  category:   z.enum(Support.TICKET_CATEGORIES),
  subject:    z.string().trim().min(3, 'Add a short subject').max(150),
  message:    z.string().trim().min(10, 'Describe the problem in a sentence or two').max(4000),
  booking_id: z.string().uuid().nullable().optional(),
  transcript: z.array(z.object({
    from: z.enum(['client', 'bot']),
    text: z.string().max(2000),
  })).max(40).optional(),
})

const resolveSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
})

function fail(res: Response, err: any) {
  const message: string = err?.message ?? 'Something went wrong'
  const status = message.includes('not found') ? 404
    : message.includes('open tickets') ? 429
    : 500
  res.status(status).json({ status: 'error', message })
}

router.post('/tickets', authenticate, authenticatedLimiter, isClient, attachClientScope, validate(openTicketSchema),
  async (req: Request, res: Response) => {
    try {
      const ticket = await Support.openTicket(req.clientId!, req.user!.sub, req.body)
      res.status(201).json({ status: 'success', data: ticket })
    } catch (err) { fail(res, err) }
  })

router.get('/tickets/mine', authenticate, authenticatedLimiter, isClient, attachClientScope,
  async (req: Request, res: Response) => {
    try {
      res.status(200).json({ status: 'success', data: await Support.listClientTickets(req.clientId!) })
    } catch (err) { fail(res, err) }
  })

router.get('/tickets', authenticate, authenticatedLimiter, isSupportDesk,
  async (req: Request, res: Response) => {
    try {
      const raw    = String(req.query.status ?? 'open')
      const status = raw === 'resolved' || raw === 'all' ? raw : 'open'
      res.status(200).json({ status: 'success', data: await Support.listTickets(status) })
    } catch (err) { fail(res, err) }
  })

router.patch('/tickets/:id/resolve', authenticate, authenticatedLimiter, isSupportDesk, validate(resolveSchema),
  async (req: Request, res: Response) => {
    try {
      const ticket = await Support.resolveTicket(String(req.params.id), req.user!.sub, req.body?.note ?? null)
      res.status(200).json({ status: 'success', data: ticket })
    } catch (err) { fail(res, err) }
  })

export default router
