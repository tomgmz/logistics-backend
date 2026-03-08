import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import {
  createBookingSchema,
  updateBookingSchema,
  updateBookingStatusSchema,
  updateDestinationSchema,
  updateDestinationStatusSchema,
} from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'

const router = Router()

//Bookings

router.get('/', BookingController.getAllBookings)
router.get('/client/:clientId', BookingController.getBookingsByClient)
router.get('/:id', BookingController.getBookingById)
router.get('/:id/destinations', BookingController.getDestinationsByBooking)
router.post('/', validate(createBookingSchema), BookingController.createBooking)
router.patch('/:id', validate(updateBookingSchema), BookingController.updateBooking)
router.patch('/:id/status', validate(updateBookingStatusSchema), BookingController.updateBookingStatus)
router.delete('/:id', BookingController.deleteBooking)

//booking destinations

router.patch('/destinations/:destinationId', validate(updateDestinationSchema), BookingController.updateDestination)
router.patch('/destinations/:destinationId/status', validate(updateDestinationStatusSchema), BookingController.updateDestinationStatus)
router.delete('/destinations/:destinationId', BookingController.deleteDestination)

export default router