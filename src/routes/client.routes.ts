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
} from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'

const router = Router()

const isAdmin  = authorize('admin', 'client')
const isClient = authorize('client')
const isAny    = authorize('admin', 'client', 'driver')

// Booking write actions are governed by the booking-management module tier for
// managed staff (clients/drivers bypass; it_admin bypasses). Method picks the
// flag: PATCH -> can_edit, DELETE -> can_delete.
const canManageBooking = requireModule('booking-management')

router.get('/',                 authenticate, authenticatedLimiter, isAdmin,  BookingController.getAllBookings)
router.get('/client/:clientId', authenticate, authenticatedLimiter, isAny,    BookingController.getBookingsByClient)
router.get('/driver/:driverId', authenticate, authenticatedLimiter,           BookingController.getBookingsByDriver)

router.get('/:id',              authenticate, authenticatedLimiter, isAny,    BookingController.getBookingById)
router.get('/:id/destinations', authenticate, authenticatedLimiter, isAny,    BookingController.getDestinationsByBooking)

router.post('/',                authenticate, authenticatedLimiter, isClient, validate(createBookingSchema),       BookingController.createBooking)
router.patch('/:id',            authenticate, authenticatedLimiter, isClient, validate(updateBookingSchema),       BookingController.updateBooking)
router.patch('/:id/status',     authenticate, authenticatedLimiter, isAdmin,  canManageBooking, validate(updateBookingStatusSchema), BookingController.updateBookingStatus)
router.delete('/:id',           authenticate, authenticatedLimiter, isClient, BookingController.deleteBooking)

router.patch('/destinations/:destinationId',        authenticate, authenticatedLimiter, isAdmin, canManageBooking, validate(updateDestinationSchema),       BookingController.updateDestination)
router.patch('/destinations/:destinationId/status', authenticate, authenticatedLimiter, isAdmin, canManageBooking, validate(updateDestinationStatusSchema), BookingController.updateDestinationStatus)
router.delete('/destinations/:destinationId',       authenticate, authenticatedLimiter, isAdmin, canManageBooking, BookingController.deleteDestination)

export default router