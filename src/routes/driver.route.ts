import { Router } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }    from '../middlewares/rateLimit.middleware.js'
import * as BookingController from '../controllers/client/booking.controller.js'

const router = Router()

const isAny = authorize('admin', 'super_admin', 'driver')

router.get('/:driverId/bookings', authenticate, authenticatedLimiter, isAny, BookingController.getBookingsByDriver)

export default router