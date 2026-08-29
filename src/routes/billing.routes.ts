import { Router } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { requireModule } from '../middlewares/moduleAccess.middleware.js'
import { attachClientScope } from '../middlewares/clientScope.middleware.js'
import { validate } from '../middlewares/validate.middleware.js'
import {
  clientReviewSummarySchema,
  clientSubmitBillingSchema,
  issueInvoiceSchema,
  issueReceiptSchema,
  recordPaymentSchema,
  saveConsolidationSchema,
  submitPaymentProofSchema,
  validateSubmissionSchema,
  verifyPaymentSchema,
} from '../schema/billing/billing.schema.js'
import * as BillingController from '../controllers/billing/billing.controller.js'

/**
 * Reverse billing, mounted at /api/billing.
 *
 * Two audiences with different gates:
 *
 *   company  authenticated staff, governed by the billing-management module
 *            tier — read to view, edit to consolidate and act, create to issue
 *            documents.
 *   client   authenticated client role, scoped by attachClientScope so a caller
 *            can only ever reach their own periods.
 *
 * Client routes sit under /me so the two trees cannot be confused, and no route
 * anywhere accepts a client id from the caller.
 */

const router = Router()

const canReadBilling   = requireModule('billing-management')
const isClient         = authorize('client')
// Staff who work billing. Fleet and operations have no business here.
const isBillingStaff   = authorize('admin', 'it_admin', 'accountant', 'general_manager')

// ---------------------------------------------------------------------------
// Client — own periods only
// ---------------------------------------------------------------------------

router.get(
  '/me/periods',
  authenticate, authenticatedLimiter, isClient, attachClientScope,
  BillingController.listPeriods,
)

router.get(
  '/me/periods/:periodId',
  authenticate, authenticatedLimiter, isClient, attachClientScope,
  BillingController.getPeriod,
)

// Monthly: the client sends their own billing summary for 8338 to cross-check.
router.post(
  '/me/periods/:periodId/submit',
  authenticate, authenticatedLimiter, isClient, attachClientScope,
  validate(clientSubmitBillingSchema),
  BillingController.submitBilling,
)

// Weekly: 8338 sent the summary; the client approves or rejects it.
router.post(
  '/me/periods/:periodId/review',
  authenticate, authenticatedLimiter, isClient, attachClientScope,
  validate(clientReviewSummarySchema),
  BillingController.reviewSummary,
)

router.get(
  '/me/invoices/:invoiceId',
  authenticate, authenticatedLimiter, isClient, attachClientScope,
  BillingController.getInvoice,
)

// Payment happens outside the system, so the client tells 8338 it happened and
// attaches evidence. This creates a claim awaiting verification, never a
// settlement — see submitPaymentProof in the service.
router.post(
  '/me/invoices/:invoiceId/proof',
  authenticate, authenticatedLimiter, isClient, attachClientScope,
  validate(submitPaymentProofSchema),
  BillingController.submitPaymentProof,
)

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

router.get(
  '/periods',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  BillingController.listPeriods,
)

router.get(
  '/periods/:periodId',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  BillingController.getPeriod,
)

// The consolidation worksheet: completed bookings in range, with prices so far.
router.get(
  '/periods/:periodId/consolidation',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  BillingController.getConsolidation,
)

router.put(
  '/periods/:periodId/consolidation',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  validate(saveConsolidationSchema),
  BillingController.saveConsolidation,
)

// Weekly only — monthly cut-offs wait for the client instead.
router.post(
  '/periods/:periodId/send-summary',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  BillingController.sendSummary,
)

// Monthly only — 8338's cross-check of what the client submitted.
router.post(
  '/periods/:periodId/validate',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  validate(validateSubmissionSchema),
  BillingController.validateSubmission,
)

// Fans the period out into one Service Invoice per booking. Resumable: bookings
// that already have an invoice are skipped rather than rejected.
router.post(
  '/periods/:periodId/invoices',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  validate(issueInvoiceSchema),
  BillingController.issueInvoices,
)

router.get(
  '/invoices/:invoiceId',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  BillingController.getInvoice,
)

router.post(
  '/invoices/:invoiceId/payments',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  validate(recordPaymentSchema),
  BillingController.recordPayment,
)

// Issuance survives a failed render, leaving pdf_url null; this fills it in
// afterwards without touching the serial.
router.post(
  '/invoices/:invoiceId/pdf',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  BillingController.regenerateInvoicePdf,
)

// The accountant's verification queue.
router.get(
  '/payments/pending',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  BillingController.listPendingPayments,
)

router.post(
  '/payments/:paymentId/verify',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  validate(verifyPaymentSchema),
  BillingController.verifyPayment,
)

router.post(
  '/payments/:paymentId/receipt',
  authenticate, authenticatedLimiter, isBillingStaff, canReadBilling,
  validate(issueReceiptSchema),
  BillingController.issueReceipt,
)

export default router
