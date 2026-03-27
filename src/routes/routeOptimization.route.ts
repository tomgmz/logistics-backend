// import { Router } from 'express'
// import { validate } from '../middlewares/validate.middleware.js'
// import { validateGoogleCredentials } from '../middlewares/routeOptimization.middleware.js'
// import { geocodeAddressSchema } from '../schema/maps/routeOptimization.schema.js'
// import * as RouteOptimizationController from '../controllers/maps/routeOptimization.controller.js'

// const router = Router()

// router.get('/:bookingId', RouteOptimizationController.getOptimizedRoute)

// router.use(validateGoogleCredentials)

// router.post(
//   '/optimize/:id',
//   RouteOptimizationController.optimizeBookingRoute
// )

// router.post(
//   '/geocode',
//   validate(geocodeAddressSchema),
//   RouteOptimizationController.geocodeAddress
// )

// export default router


import { Router } from 'express'
import { validate }                from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import {
  createBookingSchema,
  updateBookingSchema,
  updateBookingStatusSchema,
  updateDestinationSchema,
  updateDestinationStatusSchema,
} from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'

const router = Router()

const isAdmin  = authorize('admin', 'super_admin')
const isClient = authorize('client')
const isAny    = authorize('admin', 'super_admin', 'client', 'driver')

router.get('/',                 authenticate, isAdmin,  BookingController.getAllBookings)
router.get('/client/:clientId', authenticate, isAny,    BookingController.getBookingsByClient)
router.get('/:id',              authenticate, isAny,    BookingController.getBookingById)
router.get('/:id/destinations', authenticate, isAny,    BookingController.getDestinationsByBooking)
router.post('/',                authenticate, isClient, validate(createBookingSchema),       BookingController.createBooking)
router.patch('/:id',            authenticate, isClient, validate(updateBookingSchema),       BookingController.updateBooking)
router.patch('/:id/status',     authenticate, isAdmin,  validate(updateBookingStatusSchema), BookingController.updateBookingStatus)
router.delete('/:id',           authenticate, isClient, BookingController.deleteBooking)

router.patch('/destinations/:destinationId',        authenticate, isAdmin, validate(updateDestinationSchema),       BookingController.updateDestination)
router.patch('/destinations/:destinationId/status', authenticate, isAdmin, validate(updateDestinationStatusSchema), BookingController.updateDestinationStatus)
router.delete('/destinations/:destinationId',       authenticate, isAdmin, BookingController.deleteDestination)

export default router