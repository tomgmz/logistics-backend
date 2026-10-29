import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { attachClientScope } from '../middlewares/clientScope.middleware.js'
import { validate } from '../middlewares/validate.middleware.js'
import { requireModule } from '../middlewares/moduleAccess.middleware.js'
import * as Support from '../services/support/support.service.js'
import { supportInboxEmail } from '../lib/brevo-mailer.js'
import { pageQuery, paginate, searchQuery, matchesSearch } from '../lib/paginate.js'

// What the Tickets page calls each category, so a search for the label it shows finds the row.
const CATEGORY_SEARCH_LABEL: Record<string, string> = {
  booking: 'Booking', delivery: 'Delivery', tracking: 'Tracking',
  documents: 'Documents', account: 'Account', other: 'Something else',
}

/**
 * Client support tickets, raised from the web FAQ chatbot.
 *
 *   POST  /support/tickets               client opens one (emails the inbox)
 *   GET   /support/tickets/mine          the client's own tickets
 *   GET   /support/tickets?status=open   staff queue (dashboard + the Company
 *                                        Administrator's Tickets page)
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

router.get('/tickets', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'),
  async (req: Request, res: Response) => {
    try {
      const raw    = String(req.query.status ?? 'open')
      const status = raw === 'resolved' || raw === 'all' ? raw : 'open'

      const paging = pageQuery(req)
      if (paging) {
        // The Tickets table: status tab, search and the tab counts are worked
        // out here, and only the page on screen goes back.
        const all    = await Support.listTickets('all')
        const open   = all.filter((t: any) => t.status === 'open').length
        const counts = { all: all.length, open, resolved: all.length - open }
        const q      = searchQuery(req)
        const name   = (p: any) => [p?.first_name, p?.last_name].filter(Boolean).join(' ') || null
        const rows   = all
          .filter((t: any) => (status === 'all' || t.status === status) && matchesSearch(q, [
            t.reference, t.subject, t.message, t.clients?.company_name,
            name(t.opener), t.opener?.email, t.bookings?.reference_number,
            CATEGORY_SEARCH_LABEL[t.category],
          ]))
          // Open tickets oldest first (who has waited longest); otherwise newest first.
          .sort((a: any, b: any) => (status === 'open'
            ? String(a.created_at).localeCompare(String(b.created_at))
            : String(b.created_at).localeCompare(String(a.created_at))))
        const { data, meta } = paginate(rows, paging)
        return res.status(200).json({ status: 'success', data, meta: { ...meta, counts }, inbox: supportInboxEmail() })
      }

      // The inbox the tickets were emailed to; the Tickets page opens it in Gmail.
      res.status(200).json({ status: 'success', data: await Support.listTickets(status), inbox: supportInboxEmail() })
    } catch (err) { fail(res, err) }
  })

// Resolving is an edit: a Read Only Tickets tier can read the queue but not close it.
router.patch('/tickets/:id/resolve', authenticate, authenticatedLimiter, isSupportDesk, requireModule('support-tickets'), validate(resolveSchema),
  async (req: Request, res: Response) => {
    try {
      const ticket = await Support.resolveTicket(String(req.params.id), req.user!.sub, req.body?.note ?? null)
      res.status(200).json({ status: 'success', data: ticket })
    } catch (err) { fail(res, err) }
  })

export default router
