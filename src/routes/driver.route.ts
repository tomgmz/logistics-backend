import { Router } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }    from '../middlewares/rateLimit.middleware.js'
import { validate }                from '../middlewares/validate.middleware.js'
import { uploadSingle }            from '../middlewares/upload.middleware.js'
import { driverStopProofSchema }   from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'
import { uploadDeliveryProof } from '../controllers/admin/uploadImage.controller.js'

const router = Router()

const isAny = authorize('admin', 'driver')

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
