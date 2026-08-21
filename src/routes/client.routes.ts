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
  gmReviewSchema,
} from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'
import { requireGmApprover } from '../middlewares/gmApprover.middleware.js'

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

// Approval workflow: the GM is the only gate. Once approved, operations picks a
// vehicle and driver through POST /admin/assignments/:bookingId, which notifies
// the driver and the fleet manager — there is no separate fleet approval step.
//
// `requireGmApprover` admits the general manager, admins, and any user the IT
// admin has appointed as a GM proxy (an accountant standing in while the GM is
// unavailable), so it can't be a plain role check.
router.patch('/:id/gm-review', authenticate, authenticatedLimiter, requireGmApprover, validate(gmReviewSchema), BookingController.gmReview)

router.patch('/destinations/:destinationId',        authenticate, authenticatedLimiter, isAdmin, canManageBooking, validate(updateDestinationSchema),       BookingController.updateDestination)
router.patch('/destinations/:destinationId/status', authenticate, authenticatedLimiter, isAdmin, canManageBooking, validate(updateDestinationStatusSchema), BookingController.updateDestinationStatus)
router.delete('/destinations/:destinationId',       authenticate, authenticatedLimiter, isAdmin, canManageBooking, BookingController.deleteDestination)

export default router