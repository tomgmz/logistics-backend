import { Router } from 'express'
import { validate }                  from '../middlewares/validate.middleware.js'
import { authenticate, authorize }   from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }      from '../middlewares/rateLimit.middleware.js'
import { validateGoogleCredentials } from '../middlewares/routeOptimization.middleware.js'
import { attachClientScope, attachDriverScope } from '../middlewares/clientScope.middleware.js'
import { geocodeAddressSchema }      from '../schema/maps/routeOptimization.schema.js'
import * as RouteOptimizationController from '../controllers/maps/routeOptimization.controller.js'

const router = Router()

const canViewRoute     = authorize('client', 'driver', 'dispatcher', 'admin')
const canOptimizeRoute = authorize('dispatcher', 'admin', 'driver', 'client')

// `attachClientScope` pins the caller's own client_id from their session so the
// controller can check it against the booking's owner. Without it a client could
// read any company's origin and drop-off coordinates by changing the uuid — the
// role check passes and nothing downstream looked at ownership. `attachDriverScope`
// does the same for drivers, who may reach only bookings they are crewed on.
// Staff are unaffected.
router.post(
  '/optimize/:id',
  authenticate,
  authenticatedLimiter,
  canOptimizeRoute,
  attachClientScope,
  attachDriverScope,
  validateGoogleCredentials,
  RouteOptimizationController.optimizeBookingRoute
)

router.post(
  '/geocode',
  authenticate,
  authenticatedLimiter,
  canOptimizeRoute,
  validateGoogleCredentials,
  validate(geocodeAddressSchema),
  RouteOptimizationController.geocodeAddress
)

router.get('/:bookingId', authenticate, authenticatedLimiter, canViewRoute, attachClientScope, attachDriverScope, RouteOptimizationController.getOptimizedRoute)

export default router