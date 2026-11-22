import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter, assistantLimiter } from '../middlewares/rateLimit.middleware.js'
import { attachClientScope } from '../middlewares/clientScope.middleware.js'
import { validate } from '../middlewares/validate.middleware.js'
import { requireModule } from '../middlewares/moduleAccess.middleware.js'
import * as Support from '../services/support/support.service.js'
import { askAssistant } from '../services/support/assistant.service.js'
import { supportInboxEmail, ticketRepliesTracked, ticketReplyEmail } from '../lib/mailer.js'
import { pageQuery, paginate, searchQuery, matchesWords } from '../lib/paginate.js'

/**
 * Client support tickets, raised from the web FAQ chatbot.
 *
 *   POST  /support/tickets               client opens one (emails the inbox)
 *   POST  /support/tickets/staff         staff open one for a client (a call,
 *                                        an email, a walk-in) — same email thread
 *   GET   /support/clients?search=       staff: clients to open one for
 *   GET   /support/clients/:id/bookings  staff: that client's recent bookings
 *   GET   /support/tickets/mine          the client's own tickets
 *   GET   /support/tickets?status=open   staff queue (dashboard + the Company
 *                                        Administrator's Tickets page)
 *   PATCH /support/tickets/:id/resolve   staff mark it resolved (emails the client)
 *   POST  /support/assistant             client: an AI answer grounded in the FAQ
 *                                        (Gemini), asked when the web's keyword
 *                                        matcher has no confident answer
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

const staffTicketSchema = z.object({
  client_id:  z.string().uuid('Choose a client'),
  category:   z.enum(Support.TICKET_CATEGORIES),
  subject:    z.string().trim().min(3, 'Add a short subject').max(150),
  message:    z.string().trim().min(10, 'Describe the problem in a sentence or two').max(4000),
  booking_id: z.string().uuid().nullable().optional(),
}).strict()

const assistantSchema = z.object({
  question: z.string().trim().min(1).max(300),
  /** Up to three earlier questions from the same chat, for follow-ups. */
  earlier:  z.array(z.string().max(300)).max(3).optional(),
}).strict()

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

// Never an error status for a model problem: 'unavailable' tells the web to
// fall back to its keyword answers.
router.post('/assistant', authenticate, assistantLimiter, isClient, validate(assistantSchema),
  async (req: Request, res: Response) => {
    try {
      const data = await askAssistant(req.body.question, req.body.earlier ?? [])
      res.status(200).json({ status: 'success', data })
    } catch {
      res.status(200).json({ status: 'success', data: { status: 'unavailable' } })
    }
  })

// Opening one is an edit: a Read Only Tickets tier cannot.
router.post('/tickets/staff', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'), validate(staffTicketSchema),
  async (req: Request, res: Response) => {
    try {
      const ticket = await Support.openTicketForClient(req.user!.sub, req.body)
      res.status(201).json({ status: 'success', data: ticket })
    } catch (err) { fail(res, err) }
  })

// The pickers on that form: a client, then (optionally) one of their bookings.
router.get('/clients', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'),
  async (req: Request, res: Response) => {
    try {
      res.status(200).json({ status: 'success', data: await Support.searchTicketClients(String(req.query.search ?? '').slice(0, 100)) })
    } catch (err) { fail(res, err) }
  })

router.get('/clients/:clientId/bookings', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'),
  async (req: Request, res: Response) => {
    try {
      const clientId = String(req.params.clientId)
      if (!z.string().uuid().safeParse(clientId).success) return res.status(400).json({ status: 'error', message: 'Invalid client' })
      res.status(200).json({ status: 'success', data: await Support.ticketClientBookings(clientId) })
    } catch (err) { fail(res, err) }
  })

router.get('/tickets/mine', authenticate, authenticatedLimiter, isClient, attachClientScope,
  async (req: Request, res: Response) => {
    try {
      res.status(200).json({ status: 'success', data: await Support.listClientTickets(req.clientId!) })
    } catch (err) { fail(res, err) }
  })

router.get('/tickets', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'),
  async (req: Request, res: Response) => {
    try {
      const raw    = String(req.query.status ?? 'open')
      const status = raw === 'resolved' || raw === 'all' ? raw : 'open'

      const paging = pageQuery(req)
      // Newest first on every tab (user 2026-11-19: new tickets were at the end
      // of Open); the Order toggle (?reverse=1) gives queue order, the
      // longest-waiting first.
      const oldestFirst = req.query.sort === 'asc' || req.query.reverse === '1'
      if (paging) {
        // The Tickets table: status tab, search and the tab counts are worked
        // out here, and only the page on screen goes back.
        const all    = await Support.listTickets('all')
        const open   = all.filter((t: any) => t.status === 'open').length
        const counts = { all: all.length, open, resolved: all.length - open }
        const q      = searchQuery(req)
        const name   = (p: any) => [p?.first_name, p?.last_name].filter(Boolean).join(' ') || null
        const rows   = all
          // Exactly what the search box names: ticket, client, subject or booking.
          .filter((t: any) => (status === 'all' || t.status === status) && matchesWords(q, [
            t.reference, t.clients?.company_name, name(t.clients?.users), name(t.opener), t.subject, t.bookings?.reference_number,
          ]))
          .sort((a: any, b: any) => (oldestFirst
            ? String(a.created_at).localeCompare(String(b.created_at))
            : String(b.created_at).localeCompare(String(a.created_at))))
        const { data, meta } = paginate(rows, paging)
        return res.status(200).json({ status: 'success', data, meta: { ...meta, counts }, inbox: supportInboxEmail(), reply_tracking: ticketRepliesTracked(), reply_address: ticketRepliesTracked() ? ticketReplyEmail() : null })
      }

      // The inbox the tickets were emailed to; the Tickets page opens it in Gmail.
      res.status(200).json({ status: 'success', data: await Support.listTickets(status), inbox: supportInboxEmail(), reply_tracking: ticketRepliesTracked(), reply_address: ticketRepliesTracked() ? ticketReplyEmail() : null })
    } catch (err) { fail(res, err) }
  })

// Resolving is an edit: a Read Only Tickets tier can read the queue but not close it.
const ticketReplySchema = z.object({
  body: z.string().trim().min(1, 'Write a reply').max(4000),
}).strict()

// Staff answer a ticket from the Support page; it is emailed to the client.
router.post('/tickets/:id/reply', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'), validate(ticketReplySchema),
  async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id)
      if (!z.string().uuid().safeParse(id).success) return res.status(400).json({ status: 'error', message: 'Invalid ticket' })
      res.status(201).json({ status: 'success', data: await Support.replyToTicket(id, req.user!.sub, req.body.body) })
    } catch (err: any) {
      if (err?.statusCode) return res.status(err.statusCode).json({ status: 'error', message: err.message })
      fail(res, err)
    }
  })

router.patch('/tickets/:id/resolve', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'), validate(resolveSchema),
  async (req: Request, res: Response) => {
    try {
      const ticket = await Support.resolveTicket(String(req.params.id), req.user!.sub, req.body?.note ?? null)
      res.status(200).json({ status: 'success', data: ticket })
    } catch (err) { fail(res, err) }
  })

export default router
