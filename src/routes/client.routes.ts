import { Router } from 'express'
import { validate }                from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter, trackingLimiter } from '../middlewares/rateLimit.middleware.js'
import { requireModule }           from '../middlewares/moduleAccess.middleware.js'
import { attachClientScope }       from '../middlewares/clientScope.middleware.js'
import {
  createBookingSchema,
  updateBookingSchema,
  updateBookingStatusSchema,
  updateDestinationSchema,
  updateDestinationStatusSchema,
  gmReviewSchema,
} from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'
import * as TrackingController from '../controllers/driver/tracking.controller.js'
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

// `authorize` settles WHAT ROLE you are; it says nothing about WHICH COMPANY you
// belong to. Without the line below a client could read, edit, cancel or delete
// any other company's booking by changing a uuid in the URL — the role check
// passes, and nothing downstream looked at ownership. `attachClientScope` pins
// the caller's own client_id from their session (never from the URL or body),
// and the service asserts against it. It returns immediately for every
// non-client role, so admin, GM, ops, fleet, accountant and the driver app are
// unaffected. Note that `canManageBooking` does NOT cover this: `client` is not
// a managed role, so requireModule waves it straight through.
router.get('/',                 authenticate, authenticatedLimiter, canViewBookings, attachClientScope, BookingController.getAllBookings)
router.get('/client/:clientId', authenticate, authenticatedLimiter, isAny,    attachClientScope, BookingController.getBookingsByClient)
router.get('/driver/:driverId', authenticate, authenticatedLimiter,           BookingController.getBookingsByDriver)

router.get('/:id',              authenticate, authenticatedLimiter, canViewBookings, attachClientScope, BookingController.getBookingById)
router.get('/:id/destinations', authenticate, authenticatedLimiter, canViewBookings, attachClientScope, BookingController.getDestinationsByBooking)

// Where the truck is now. The map subscribes to a realtime channel for updates;
// this serves the first paint and the fallback poll when that channel is down,
// so it is on `trackingLimiter` rather than the shared budget — a client sitting
// on the page with a broken socket polls it every 30 s.
router.get('/:id/live-position', authenticate, trackingLimiter, canViewBookings, attachClientScope, TrackingController.getLivePosition)

router.post('/',                authenticate, authenticatedLimiter, isClient, attachClientScope, validate(createBookingSchema),       BookingController.createBooking)
router.patch('/:id',            authenticate, authenticatedLimiter, isClient, attachClientScope, validate(updateBookingSchema),       BookingController.updateBooking)
router.patch('/:id/status',     authenticate, authenticatedLimiter, isAdmin,  attachClientScope, canManageBooking, validate(updateBookingStatusSchema), BookingController.updateBookingStatus)
router.delete('/:id',           authenticate, authenticatedLimiter, isClient, attachClientScope, BookingController.deleteBooking)

// Approval workflow: the GM is the only gate. Once approved, operations picks a
// vehicle and driver through POST /admin/assignments/:bookingId, which notifies
// the driver and the fleet manager — there is no separate fleet approval step.
//
// `requireGmApprover` admits the general manager, admins, and any user the IT
// admin has appointed as a GM proxy (an accountant standing in while the GM is
// unavailable), so it can't be a plain role check.
router.patch('/:id/gm-review', authenticate, authenticatedLimiter, requireGmApprover, validate(gmReviewSchema), BookingController.gmReview)

// Same story one level down: `isAdmin` admits clients, so these need the stop's
// parent booking checked against the caller's own company too.
router.patch('/destinations/:destinationId',        authenticate, authenticatedLimiter, isAdmin, attachClientScope, canManageBooking, validate(updateDestinationSchema),       BookingController.updateDestination)
router.patch('/destinations/:destinationId/status', authenticate, authenticatedLimiter, isAdmin, attachClientScope, canManageBooking, validate(updateDestinationStatusSchema), BookingController.updateDestinationStatus)
router.delete('/destinations/:destinationId',       authenticate, authenticatedLimiter, isAdmin, attachClientScope, canManageBooking, BookingController.deleteDestination)

export default router