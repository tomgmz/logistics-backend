import { Router } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { requireModule, requireModuleFlag } from '../middlewares/moduleAccess.middleware.js'
import * as TransactionHistoryController from '../controllers/admin/transaction-history.controller.js'

/**
 * Staff transaction history, mounted at /api/transaction-history.
 *
 * Deliberately separate from GET /api/booking, which is gated by the
 * booking-management module. An IT Admin can legitimately take
 * booking-management away from a role while leaving transaction-history
 * granted; sharing the booking route would 403 this page in that
 * configuration.
 *
 * There is no client-facing branch here. Clients read their own history
 * through /api/booking/client/:clientId, which is scoped by session.
 */

const router = Router()

const isHistoryStaff = authorize('admin', 'it_admin')
const canReadHistory = requireModule('transaction-history')
// An export is a GET, and requiredFlagForMethod maps every GET to can_view, so
// the flag has to be named explicitly or the export tier means nothing.
const canExportHistory = requireModuleFlag('transaction-history', 'can_export')

router.get(
  '/',
  authenticate, authenticatedLimiter, isHistoryStaff, canReadHistory,
  TransactionHistoryController.list,
)

router.get(
  '/summary',
  authenticate, authenticatedLimiter, isHistoryStaff, canReadHistory,
  TransactionHistoryController.summary,
)

// Options for the company filter. Kept separate from GET /api/admin/clients so
// this module's role gate stays independent of the client CRUD gate.
router.get(
  '/companies',
  authenticate, authenticatedLimiter, isHistoryStaff, canReadHistory,
  TransactionHistoryController.companies,
)

router.get(
  '/export',
  authenticate, authenticatedLimiter, isHistoryStaff, canExportHistory,
  TransactionHistoryController.exportRows,
)

export default router
