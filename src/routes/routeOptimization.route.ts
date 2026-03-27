import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { authenticate, authorize } from '../middlewares/auth.middleware.js'
import { validateGoogleCredentials } from '../middlewares/routeOptimization.middleware.js'
import { geocodeAddressSchema } from '../schema/maps/routeOptimization.schema.js'
import * as RouteOptimizationController from '../controllers/maps/routeOptimization.controller.js'

const router = Router()

// Role-based access
const canViewRoute = authorize('client', 'driver', 'dispatcher', 'admin')
const canOptimizeRoute = authorize('dispatcher', 'admin', 'driver')

router.get('/:bookingId', authenticate, canViewRoute, RouteOptimizationController.getOptimizedRoute)

// POST optimize route - only dispatcher/admin
router.post(
  '/optimize/:id',
  authenticate,
  canOptimizeRoute,
  validateGoogleCredentials,
  RouteOptimizationController.optimizeBookingRoute
)

// POST geocode address - only dispatcher/driver/admin
router.post(
  '/geocode',
  authenticate,
  canOptimizeRoute,
  validateGoogleCredentials,
  validate(geocodeAddressSchema),
  RouteOptimizationController.geocodeAddress
)

export default router