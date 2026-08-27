import { Router } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }    from '../middlewares/rateLimit.middleware.js'
import { validate }                from '../middlewares/validate.middleware.js'
import { uploadSingle }            from '../middlewares/upload.middleware.js'
import { driverStopProofSchema }   from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'
import * as AvailabilityController from '../controllers/driver/availability.controller.js'
import { driverAvailabilitySchema, driverAvailabilityDaysSchema } from '../schema/client/booking.schema.js'
import { uploadDeliveryProof } from '../controllers/admin/uploadImage.controller.js'

const router = Router()

const isAny = authorize('admin', 'driver')

// The driver's own availability switch. A driver only enters the assignable pool
// by turning this on; it is locked while they are out on a delivery. Declared
// before /:driverId/* so 'availability' is never read as a driver id.
router.get('/availability',   authenticate, authenticatedLimiter, isAny, AvailabilityController.getMyAvailability)
router.patch('/availability', authenticate, authenticatedLimiter, isAny, validate(driverAvailabilitySchema), AvailabilityController.setMyAvailability)

// The same driver's month-by-month plan, ticked on the calendar behind the
// availability pill. GET defaults to the current Philippine month.
router.get('/availability/days', authenticate, authenticatedLimiter, isAny, AvailabilityController.getMyAvailabilityDays)
router.put('/availability/days', authenticate, authenticatedLimiter, isAny, validate(driverAvailabilityDaysSchema), AvailabilityController.setMyAvailabilityDays)

router.get('/:driverId/bookings', authenticate, authenticatedLimiter, isAny, BookingController.getBookingsByDriver)

// Proof-of-pickup / proof-of-delivery photo (multipart, field `image`). Returns
// the hosted URL, which the app then sends with the stop confirmation below.
router.post(
  '/proof-photo',
  authenticate,
  authenticatedLimiter,
  isAny,
  (req, res, next) => {
    uploadSingle(req, res, (err) => {
      if (err) return res.status(400).json({ status: 'error', message: err.message })
      next()
    })
  },
  uploadDeliveryProof,
)

// Trip progress confirmed by the driver from the navigation map, in order:
// pickup -> each drop-off -> the whole delivery. Authorization is per booking
// (the caller must be the assigned driver; admins bypass), so these are NOT
// behind the admin-only booking-management gates the equivalent client routes
// use. Each stop carries its proof photo; completion needs no body.
router.patch('/bookings/:bookingId/pickup',
  authenticate, authenticatedLimiter, isAny, validate(driverStopProofSchema), BookingController.driverConfirmPickup)
router.patch('/bookings/:bookingId/destinations/:destinationId/delivered',
  authenticate, authenticatedLimiter, isAny, validate(driverStopProofSchema), BookingController.driverConfirmDelivery)
router.patch('/bookings/:bookingId/complete',
  authenticate, authenticatedLimiter, isAny, BookingController.driverCompleteBooking)

export default router
