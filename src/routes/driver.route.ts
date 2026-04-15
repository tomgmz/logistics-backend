import { Router } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import * as BookingController from '../controllers/client/booking.controller.js'

const router = Router()

const isDriver = authorize('driver')
const isAny    = authorize('admin', 'super_admin', 'driver')

router.get('/:driverId/bookings', authenticate, isAny, BookingController.getBookingsByDriver)

export default router