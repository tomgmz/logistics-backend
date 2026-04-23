import { Router } from 'express'
import { validate }                  from '../middlewares/validate.middleware.js'
import { authenticate, authorize }   from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }      from '../middlewares/rateLimit.middleware.js'
import { validateGoogleCredentials } from '../middlewares/routeOptimization.middleware.js'
import { geocodeAddressSchema }      from '../schema/maps/routeOptimization.schema.js'
import * as RouteOptimizationController from '../controllers/maps/routeOptimization.controller.js'

const router = Router()

const canViewRoute     = authorize('client', 'driver', 'dispatcher', 'super_admin')
const canOptimizeRoute = authorize('dispatcher', 'super_admin', 'driver', 'client')

router.post(
  '/optimize/:id',
  authenticate,
  authenticatedLimiter,
  canOptimizeRoute,
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

router.get('/:bookingId', authenticate, authenticatedLimiter, canViewRoute, RouteOptimizationController.getOptimizedRoute)

export default router