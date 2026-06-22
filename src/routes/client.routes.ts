import { Router } from 'express'
import { validate }                from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }    from '../middlewares/rateLimit.middleware.js'
import { requireModule }           from '../middlewares/moduleAccess.middleware.js'
import {
  createBookingSchema,
  updateBookingSchema,
  updateBookingStatusSchema,
  updateDestinationSchema,
  updateDestinationStatusSchema,
  accountingReviewSchema,
  gmReviewSchema,
  opsAssignSchema,
  fleetReviewSchema,
} from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'

const router = Router()

const isAdmin  = authorize('admin', 'client')
const isClient = authorize('client')
const isAny    = authorize('admin', 'client', 'driver')

// All staff roles that share the booking-management view (read access). The view
// itself filters what each role sees (e.g. ops sees approved, fleet sees assigned).
const canViewBookings = authorize(
  'admin', 'client', 'driver',
  'accountant', 'general_manager', 'operations_manager', 'fleet_manager',
)

// Approval-stage gates: stage authority is inherent to the ROLE (not the
// booking-management module tier — accountant is read-only and fleet has no
// booking-management at all), so these are gated by role only.
const isAccountant = authorize('accountant', 'admin')
const isGm         = authorize('general_manager', 'admin')
const isOps        = authorize('operations_manager', 'admin')
const isFleet      = authorize('fleet_manager', 'admin')

// Booking write actions are governed by the booking-management module tier for
// managed staff (clients/drivers bypass; it_admin bypasses). Method picks the
// flag: PATCH -> can_edit, DELETE -> can_delete.
const canManageBooking = requireModule('booking-management')

router.get('/',                 authenticate, authenticatedLimiter, canViewBookings, BookingController.getAllBookings)
router.get('/client/:clientId', authenticate, authenticatedLimiter, isAny,    BookingController.getBookingsByClient)
router.get('/driver/:driverId', authenticate, authenticatedLimiter,           BookingController.getBookingsByDriver)

router.get('/:id',              authenticate, authenticatedLimiter, canViewBookings, BookingController.getBookingById)
router.get('/:id/destinations', authenticate, authenticatedLimiter, canViewBookings, BookingController.getDestinationsByBooking)

router.post('/',                authenticate, authenticatedLimiter, isClient, validate(createBookingSchema),       BookingController.createBooking)
router.patch('/:id',            authenticate, authenticatedLimiter, isClient, validate(updateBookingSchema),       BookingController.updateBooking)
router.patch('/:id/status',     authenticate, authenticatedLimiter, isAdmin,  canManageBooking, validate(updateBookingStatusSchema), BookingController.updateBookingStatus)
router.delete('/:id',           authenticate, authenticatedLimiter, isClient, BookingController.deleteBooking)

// Approval workflow: accounting -> GM -> operations -> fleet (BLOWBAGETS).
// Gated by role only (see note above); each role may act on its own stage.
router.patch('/:id/accounting-review', authenticate, authenticatedLimiter, isAccountant, validate(accountingReviewSchema), BookingController.accountingReview)
router.patch('/:id/gm-review',         authenticate, authenticatedLimiter, isGm,         validate(gmReviewSchema),         BookingController.gmReview)
router.patch('/:id/ops-assign',        authenticate, authenticatedLimiter, isOps,        validate(opsAssignSchema),        BookingController.opsAssign)
router.patch('/:id/fleet-review',      authenticate, authenticatedLimiter, isFleet,      validate(fleetReviewSchema),      BookingController.fleetApprove)

router.patch('/destinations/:destinationId',        authenticate, authenticatedLimiter, isAdmin, canManageBooking, validate(updateDestinationSchema),       BookingController.updateDestination)
router.patch('/destinations/:destinationId/status', authenticate, authenticatedLimiter, isAdmin, canManageBooking, validate(updateDestinationStatusSchema), BookingController.updateDestinationStatus)
router.delete('/destinations/:destinationId',       authenticate, authenticatedLimiter, isAdmin, canManageBooking, BookingController.deleteDestination)

export default router