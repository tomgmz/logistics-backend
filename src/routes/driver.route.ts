import { Router } from 'express'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { authenticatedLimiter, emergencyLimiter, trackingLimiter } from '../middlewares/rateLimit.middleware.js'
import { validate }                from '../middlewares/validate.middleware.js'
import { attachDriverScope }       from '../middlewares/clientScope.middleware.js'
import { uploadSingle }            from '../middlewares/upload.middleware.js'
import { driverStopProofSchema }   from '../schema/client/booking.schema.js'
import * as BookingController from '../controllers/client/booking.controller.js'
import * as AvailabilityController from '../controllers/driver/availability.controller.js'
import * as TrackingController from '../controllers/driver/tracking.controller.js'
import * as TripController from '../controllers/client/trip.controller.js'
import * as ReportController from '../controllers/driver/report.controller.js'
import * as EmergencyCallController from '../controllers/driver/emergency-call.controller.js'
import { driverAvailabilityDaysSchema, driverLocationPingSchema } from '../schema/client/booking.schema.js'
import {
  tripStopProofSchema,
  tripPickupProofSchema,
  tripStopOrderSchema,
  fleetReturnSchema,
  attachStopProofSchema,
  startDeliverySchema,
  loadTransferSchema,
  recordMilestoneSchema,
} from '../schema/client/trip.schema.js'
import { createDriverReportSchema, enrichDriverReportSchema } from '../schema/driver/report.schema.js'
import { startEmergencyCallSchema, endEmergencyCallSchema } from '../schema/driver/emergency-call.schema.js'
import { uploadDeliveryProof } from '../controllers/admin/uploadImage.controller.js'

const router = Router()

const isAny = authorize('admin', 'driver')

// Whether the driver is out on a delivery right now — read-only. There is no
// on/off switch: the calendar below is the driver's opt-in. Declared before
// /:driverId/* so 'availability' is never read as a driver id.
router.get('/availability',   authenticate, authenticatedLimiter, isAny, AvailabilityController.getMyAvailability)

// The driver's month-by-month plan, ticked on the calendar behind the
// availability pill. These days ARE the assignable pool: operations can put the
// driver on a booking scheduled for a ticked day and on no other. GET defaults
// to the current Philippine month.
router.get('/availability/days', authenticate, authenticatedLimiter, isAny, AvailabilityController.getMyAvailabilityDays)
router.put('/availability/days', authenticate, authenticatedLimiter, isAny, validate(driverAvailabilityDaysSchema), AvailabilityController.setMyAvailabilityDays)

// Scoped, not just role-gated: isAny admits every driver, so without this one
// driver could read another's bookings.
router.get('/:driverId/bookings', authenticate, authenticatedLimiter, isAny, attachDriverScope, BookingController.getBookingsByDriver)

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

// ── Multi-trip progress ─────────────────────────────────────────────────────
//
// A booking whose cargo exceeds the body is completed by the SAME vehicle
// running the route several times. The single-trip routes above still work (an
// app build already in a driver's pocket speaks them, and a delivery half
// finished against them has to be able to finish), but these are the ones the
// current app uses:
//
//   GET  .../trips                       the plan, created on first read if unset
//   PATCH .../trips/:tripId/pickup       loaded for THIS run — one photo per run
//   PATCH .../trip-stops/:tripStopId/delivered   unloaded at one bay of one run
//   PATCH .../fleet-return               the vehicle is back in the 8338 lot
//
// Authorization is per booking (the caller must be the assigned driver; admins
// bypass), the same as the single-trip routes.
router.get('/bookings/:bookingId/trips',
  authenticate, authenticatedLimiter, isAny, TripController.getTrips)

// Start / Resume Navigation: the booking is in transit from here, and its crew
// can no longer be swapped from the web. Idempotent; the queue may re-send it.
router.post('/bookings/:bookingId/start',
  authenticate, authenticatedLimiter, isAny, validate(startDeliverySchema), TripController.driverStartDelivery)

router.patch('/trips/:tripId/pickup',
  authenticate, authenticatedLimiter, isAny, validate(tripPickupProofSchema), TripController.driverConfirmTripPickup)

// The driver picked which drop-off to do next; saved so the web shows it.
router.put('/trips/:tripId/stop-order',
  authenticate, authenticatedLimiter, isAny, validate(tripStopOrderSchema), TripController.driverSetStopOrder)

router.patch('/trip-stops/:tripStopId/delivered',
  authenticate, authenticatedLimiter, isAny, validate(tripStopProofSchema), TripController.driverConfirmTripStop)

// The same two confirmations naming the trip by its number: when the driver
// loads less than planned while offline, the phone moves the rest onto the next
// trip (or a new one) itself, and those have no server id until it syncs.
router.patch('/bookings/:bookingId/trips/:tripNumber/pickup',
  authenticate, authenticatedLimiter, isAny, validate(tripPickupProofSchema), TripController.driverConfirmTripPickup)
router.patch('/bookings/:bookingId/trips/:tripNumber/destinations/:destinationId/delivered',
  authenticate, authenticatedLimiter, isAny, validate(tripStopProofSchema), TripController.driverConfirmTripStop)

// Evidence that arrives late. The delivery was confirmed at the bay; the photo
// did not get out of the dead zone with it. The driver supplies it from the
// assignment screen once signal returns, or after the booking is done.
router.patch('/trip-stops/:tripStopId/proof',
  authenticate, authenticatedLimiter, isAny, validate(attachStopProofSchema), TripController.attachStopProof)

// After the office replaced the vehicle on the road with the load aboard the old
// one: the new driver moves it across and confirms with a photo. Drop-offs are
// refused until then.
router.get('/bookings/:bookingId/load-transfer',
  authenticate, authenticatedLimiter, isAny, TripController.getLoadTransfer)
router.patch('/bookings/:bookingId/load-transfer',
  authenticate, authenticatedLimiter, isAny, validate(loadTransferSchema), TripController.driverConfirmLoadTransfer)

// The steps around each stop: arrived at the parking, docked, started loading /
// unloading, departed (the finish is the proof confirmation). Through the queue.
router.post('/bookings/:bookingId/milestones',
  authenticate, authenticatedLimiter, isAny, validate(recordMilestoneSchema), TripController.driverRecordMilestone)

// The job ends when the truck is home, not when the last box is off it.
router.patch('/bookings/:bookingId/fleet-return',
  authenticate, authenticatedLimiter, isAny, validate(fleetReturnSchema), TripController.driverConfirmFleetReturn)

// Pausing and resuming a delivery is the office's call (see admin.route.ts).
// These answer older app builds, whose offline queue may still hold one.
router.patch('/bookings/:bookingId/pause',  authenticate, TripController.driverPauseRetired)
router.patch('/bookings/:bookingId/resume', authenticate, TripController.driverPauseRetired)

// ── Reports ─────────────────────────────────────────────────────────────────
//
// The driver app's Reports module — the quick alert (SOS) and the detailed
// emergency form are the same record, distinguished by `source`. All of these
// are scoped to the driver on the SESSION; there is deliberately no driver id in
// any of these URLs.
router.get('/reports',              authenticate, authenticatedLimiter, isAny, ReportController.listMyReports)
router.get('/reports/:reportId',    authenticate, authenticatedLimiter, isAny, ReportController.getReport)
// On its own budget, not the shared one: an SOS must not be refused because the
// driver spent the session's allowance reading their own bookings. See
// emergencyLimiter.
router.post('/reports',             authenticate, emergencyLimiter, isAny, validate(createDriverReportSchema), ReportController.createReport)
// Filling in a quick alert after the fact, so the one-tap signal grows into a
// full report instead of the driver filing a second, duplicate one.
router.patch('/reports/:reportId',  authenticate, authenticatedLimiter, isAny, validate(enrichDriverReportSchema), ReportController.enrichReport)
// The number a quick alert phones after it is sent (Operations Manager on duty,
// else the Company Administrator). The app prefetches and caches it so the call
// still works when the driver has signal but no data.
router.get('/emergency-contact',    authenticate, authenticatedLimiter, isAny, ReportController.getEmergencyContact)
// The in-app voice call (LiveKit) that follows a quick alert. Rings every
// Operations Manager's browser at once (Company Administrators when there are
// none). The phone falls back to its dialer when this fails or goes unanswered.
router.post('/emergency-calls',               authenticate, emergencyLimiter, isAny, validate(startEmergencyCallSchema), EmergencyCallController.startCall)
router.post('/emergency-calls/:callId/end',   authenticate, emergencyLimiter, isAny, validate(endEmergencyCallSchema), EmergencyCallController.endCallAsDriver)

// Live position while the booking is in transit — the highest-frequency route in
// the system, on its own rate-limit budget because the shared one is sized for a
// session's worth of ordinary requests, not one every five seconds. Same
// per-booking authorization as the confirmations above.
router.post('/bookings/:bookingId/location',
  authenticate, trackingLimiter, isAny, validate(driverLocationPingSchema), TrackingController.recordDriverPosition)

export default router
